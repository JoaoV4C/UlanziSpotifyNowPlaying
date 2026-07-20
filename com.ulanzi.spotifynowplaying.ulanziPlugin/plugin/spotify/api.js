// Wrapper dos endpoints do Spotify Web API usados pelo plugin.
// Garante um access token válido (renova via refresh token) e reenvia a
// requisição uma vez em caso de 401.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tokenStore from './tokenStore.js';
import { refreshAccessToken } from './auth.js';
import { logLine } from '../diaglog.js';

const BASE = 'https://api.spotify.com/v1';

// Persiste o fim do bloqueio para sobreviver a reinícios do processo — assim o
// plugin não volta a martelar a API durante um cooldown ainda ativo.
const BLOCK_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ratelimit.json');

/** Erro específico: não há dispositivo Spotify ativo (a API retorna 404). */
export class NoActiveDeviceError extends Error {
  constructor() {
    super('Nenhum dispositivo Spotify ativo.');
    this.name = 'NoActiveDeviceError';
  }
}

/**
 * O Spotify recusou o comando no contexto atual (403 "Restriction violated").
 * Ex.: mandar "previous" no início da faixa, "next" sem próxima, ou play/pause
 * redundante. Não é um erro de configuração — o chamador pode ignorar de leve.
 */
export class RestrictionError extends Error {
  constructor(message) {
    super(message || 'Comando não permitido agora.');
    this.name = 'RestrictionError';
  }
}

/**
 * Rate limit atingido (429). `retryAfterMs` diz por quanto tempo o chamador deve
 * parar de fazer requisições. Continuar batendo durante o cooldown prolonga o
 * bloqueio, então respeitar este tempo é essencial.
 */
export class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super('Rate limit do Spotify atingido.');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// Bloqueio global até este timestamp (ms). Enquanto ativo, nenhuma requisição
// é enviada — falha localmente com RateLimitError para evitar prolongar o 429.
// Inicializado a partir do disco para respeitar um cooldown anterior.
let blockedUntil = loadBlockedUntil();

function loadBlockedUntil() {
  try {
    const { blockedUntil: v } = JSON.parse(fs.readFileSync(BLOCK_FILE, 'utf8'));
    const ts = Number(v) || 0;
    if (ts > Date.now()) {
      logLine(`RATE_LIMIT restaurado do disco — bloqueado até ${new Date(ts).toISOString()}`);
      return ts;
    }
  } catch {
    /* sem arquivo ou inválido — sem bloqueio */
  }
  return 0;
}

function saveBlockedUntil() {
  try {
    fs.writeFileSync(BLOCK_FILE, JSON.stringify({ blockedUntil }));
  } catch {
    /* ignore */
  }
}

/** Tempo restante (ms) de bloqueio por rate limit, ou 0 se liberado. */
export function rateLimitRemainingMs() {
  return Math.max(0, blockedUntil - Date.now());
}

async function validToken() {
  if (tokenStore.hasValidAccessToken()) {
    return tokenStore.getAccessToken();
  }
  return refreshAccessToken();
}

/**
 * Faz uma requisição autenticada. Renova o token e tenta de novo em 401.
 * @param {string} path  ex: '/me/player/currently-playing'
 * @param {RequestInit} [opts]
 * @param {boolean} [retry=true]
 */
async function request(path, opts = {}, retry = true, allowActivate = true) {
  // Se estamos em cooldown de rate limit, nem envia — falha localmente.
  const remaining = rateLimitRemainingMs();
  if (remaining > 0) {
    throw new RateLimitError(remaining);
  }

  const token = await validToken();
  const resp = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });

  if (resp.status === 429) {
    // Respeita Retry-After (segundos). Bloqueia todas as requisições até lá.
    const header = resp.headers.get('retry-after');
    const seconds = Number(header);
    const retryAfterMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
    blockedUntil = Date.now() + retryAfterMs;
    saveBlockedUntil();
    logLine(
      `RATE_LIMIT 429 em ${path} — Retry-After: ${header ?? '(ausente, assumindo 5)'}s; ` +
        `bloqueado até ${new Date(blockedUntil).toISOString()}`
    );
    throw new RateLimitError(retryAfterMs);
  }

  // Primeira resposta não-429 depois de um bloqueio: registra a liberação.
  if (blockedUntil > 0 && resp.status !== 429) {
    logLine('RATE_LIMIT liberado — requisições normalizadas.');
    blockedUntil = 0;
    saveBlockedUntil();
  }

  if (resp.status === 401 && retry) {
    await refreshAccessToken();
    return request(path, opts, false, allowActivate);
  }
  if (resp.status === 404) {
    // Nos endpoints de player, 404 = "sem dispositivo ativo". Ativamos apenas o
    // Spotify DESTE PC e repetimos o comando naquele dispositivo (via ?device_id=),
    // que funciona mesmo enquanto ele acaba de ficar ativo. Se este PC não estiver
    // disponível, activateAvailableDevice lança NoActiveDeviceError.
    if (allowActivate) {
      const deviceId = await activateAvailableDevice();
      const sep = path.includes('?') ? '&' : '?';
      return request(`${path}${sep}device_id=${deviceId}`, opts, retry, /*allowActivate*/ false);
    }
    throw new NoActiveDeviceError();
  }
  if (resp.status === 403) {
    // "Restriction violated": comando não permitido no contexto atual.
    const msg = await readError(resp);
    throw new RestrictionError(msg);
  }
  if (resp.status === 204) {
    return null; // sem conteúdo (ex.: nada tocando)
  }
  if (!resp.ok) {
    throw new Error(`Spotify API ${resp.status}: ${await readError(resp)}`);
  }
  // Só interpreta como JSON se o corpo realmente for JSON. Os endpoints de
  // controle (play/pause/next/previous/volume) respondem 200/202 sem JSON.
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return null;
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Extrai a mensagem de erro do Spotify (JSON { error: { message } }) ou texto cru.
async function readError(resp) {
  const txt = await resp.text().catch(() => '');
  try {
    const j = JSON.parse(txt);
    return j?.error?.message || txt.slice(0, 200);
  } catch {
    return txt.slice(0, 200);
  }
}

/**
 * Estado atual do player. Retorna null se nada está tocando.
 * @returns {Promise<null | {
 *   isPlaying: boolean,
 *   trackId: string,
 *   title: string,
 *   artist: string,
 *   coverUrl: string,
 *   volumePercent: number|null,
 *   shuffle: boolean,
 *   repeatMode: 'off'|'context'|'track'
 * }>}
 */
export async function getPlaybackState() {
  const data = await request('/me/player');
  if (!data || !data.item) return null;
  const item = data.item;
  return {
    isPlaying: Boolean(data.is_playing),
    trackId: item.id || '',
    title: item.name || '',
    artist: (item.artists || []).map((a) => a.name).join(', '),
    coverUrl: pickCover(item.album?.images),
    volumePercent:
      typeof data.device?.volume_percent === 'number' ? data.device.volume_percent : null,
    progressMs: typeof data.progress_ms === 'number' ? data.progress_ms : 0,
    shuffle: Boolean(data.shuffle_state),
    // 'off' | 'context' (playlist/álbum) | 'track' (faixa atual)
    repeatMode: typeof data.repeat_state === 'string' ? data.repeat_state : 'off',
  };
}

function pickCover(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  // images vem ordenado do maior para o menor; pegamos o maior para fatiar bem.
  return images[0].url || '';
}

// ---- Dispositivos (ativar o Spotify aberto no PC) ----------------------------

/** Lista os dispositivos Spotify disponíveis (mesmo os inativos). */
export async function getDevices() {
  const data = await request('/me/player/devices', {}, true, /*allowActivate*/ false);
  return Array.isArray(data?.devices) ? data.devices : [];
}

// Normaliza um nome para comparação (case-insensitive, sem espaços nas pontas).
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Encontra o Spotify DESTE computador: um device do tipo 'Computer' cujo nome
 * bate com o hostname da máquina. É o único que ativamos automaticamente, para
 * nunca acionar o Spotify de outro aparelho (ex.: celular) por engano.
 */
function findLocalComputer(devices) {
  const host = norm(os.hostname());
  return devices.find(
    (d) => d.type === 'Computer' && !d.is_restricted && norm(d.name) === host
  ) || null;
}

/** Transfere/ativa a reprodução para um dispositivo. `play` inicia o playback. */
export async function transferPlayback(deviceId, play = false) {
  await request(
    '/me/player',
    { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play }) },
    true,
    /*allowActivate*/ false
  );
}

/**
 * Quando um comando dá 404 (sem dispositivo ativo), decide onde agir:
 *  - se já há um device ativo (qualquer um), usa-o (não deveria dar 404, mas por
 *    segurança);
 *  - senão, ativa APENAS o Spotify deste PC (Computer com nome == hostname).
 * Lança NoActiveDeviceError se este PC não estiver disponível.
 * @returns {Promise<string>} o device_id em que o comando deve ser repetido.
 */
async function activateAvailableDevice() {
  const devices = await getDevices();

  const active = devices.find((d) => d.is_active);
  if (active) return active.id; // já há algo tocando — controla esse

  const local = findLocalComputer(devices);
  if (!local) {
    // Nenhum device ativo e o Spotify deste PC não está disponível.
    throw new NoActiveDeviceError();
  }

  await transferPlayback(local.id, /*play*/ false);
  // Pequena espera para o Spotify registrar o dispositivo como ativo.
  await new Promise((r) => setTimeout(r, 400));
  return local.id;
}

export async function play() {
  await request('/me/player/play', { method: 'PUT' });
}

export async function pause() {
  await request('/me/player/pause', { method: 'PUT' });
}

/** Alterna play/pause conforme o estado atual. Retorna o novo isPlaying. */
export async function togglePlayPause() {
  const state = await getPlaybackState();
  const willPlay = !(state && state.isPlaying);
  if (willPlay) await play();
  else await pause();
  return willPlay;
}

export async function next() {
  await request('/me/player/next', { method: 'POST' });
}

/** Liga/desliga o modo aleatório (shuffle) no dispositivo ativo. */
export async function setShuffle(state) {
  await request(`/me/player/shuffle?state=${state ? 'true' : 'false'}`, { method: 'PUT' });
}

/** Alterna o shuffle conforme o estado atual. Retorna o novo estado. */
export async function toggleShuffle() {
  const playback = await getPlaybackState();
  const next = !(playback && playback.shuffle);
  await setShuffle(next);
  return next;
}

/**
 * Define o modo de repetição.
 * @param {'off'|'context'|'track'} mode
 */
export async function setRepeat(mode) {
  await request(`/me/player/repeat?state=${mode}`, { method: 'PUT' });
}

// Ciclo do botão, igual ao app do Spotify: desligado → repetir tudo → repetir faixa.
const REPEAT_CYCLE = { off: 'context', context: 'track', track: 'off' };

/** Avança o modo de repetição no ciclo. Retorna o novo modo. */
export async function cycleRepeat() {
  const playback = await getPlaybackState();
  const current = playback?.repeatMode || 'off';
  const next = REPEAT_CYCLE[current] || 'context';
  await setRepeat(next);
  return next;
}

/** Reinicia a faixa atual (volta ao início). */
export async function seekToStart() {
  await request('/me/player/seek?position_ms=0', { method: 'PUT' });
}

// Além deste ponto (ms) na faixa, "anterior" reinicia; antes dele, vai para a
// faixa anterior — como no app do Spotify.
const PREVIOUS_RESTART_THRESHOLD_MS = 3000;

/**
 * "Anterior" no estilo do app do Spotify: se a faixa já passou de ~3s, reinicia;
 * se está no começo, vai para a faixa anterior.
 */
export async function previous() {
  let progressMs = 0;
  try {
    const state = await getPlaybackState();
    progressMs = state?.progressMs ?? 0;
  } catch {
    // Sem estado, cai no comportamento padrão (faixa anterior).
  }
  if (progressMs > PREVIOUS_RESTART_THRESHOLD_MS) {
    await seekToStart();
  } else {
    await request('/me/player/previous', { method: 'POST' });
  }
}

/** Define o volume (0..100). */
export async function setVolume(percent) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  await request(`/me/player/volume?volume_percent=${v}`, { method: 'PUT' });
}

// ---- Biblioteca (curtir faixas) ----------------------------------------------
// API nova (fev/2026): endpoints genéricos /me/library com Spotify URIs.
// Requer os escopos user-library-read (contains) e user-library-modify (save/remove).

const trackUri = (trackId) => `spotify:track:${trackId}`;

/** true se a faixa está salva (curtida) na biblioteca do usuário. */
export async function isTrackSaved(trackId) {
  if (!trackId) return false;
  const uris = encodeURIComponent(trackUri(trackId));
  const data = await request(`/me/library/contains?uris=${uris}`);
  // A resposta é um array de booleanos, alinhado com as URIs enviadas.
  return Array.isArray(data) ? Boolean(data[0]) : false;
}

/** Salva (curte) a faixa. `uris` vai na query, como no /contains. */
export async function saveTrack(trackId) {
  const uris = encodeURIComponent(trackUri(trackId));
  await request(`/me/library?uris=${uris}`, { method: 'PUT' });
}

/** Remove (descurte) a faixa. */
export async function removeTrack(trackId) {
  const uris = encodeURIComponent(trackUri(trackId));
  await request(`/me/library?uris=${uris}`, { method: 'DELETE' });
}

// ---- Playlists ----------------------------------------------------------------

/**
 * Detalhes de uma playlist (nome + capa).
 * @param {string} playlistId
 * @returns {Promise<{ name: string, coverUrl: string }>}
 */
export async function getPlaylist(playlistId) {
  // fields limita a resposta ao que usamos (nome e capa), reduzindo o payload.
  const data = await request(`/playlists/${playlistId}?fields=name,images`);
  const images = Array.isArray(data?.images) ? data.images : [];
  return {
    name: data?.name || '',
    coverUrl: images[0]?.url || '',
  };
}

/**
 * Inicia a reprodução de um contexto (playlist/álbum) no dispositivo ativo.
 * @param {string} contextUri ex.: 'spotify:playlist:37i9dQ...'
 */
export async function playContext(contextUri) {
  await request('/me/player/play', {
    method: 'PUT',
    body: JSON.stringify({ context_uri: contextUri }),
  });
}
