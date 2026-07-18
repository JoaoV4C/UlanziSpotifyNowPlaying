// Wrapper dos endpoints do Spotify Web API usados pelo plugin.
// Garante um access token válido (renova via refresh token) e reenvia a
// requisição uma vez em caso de 401.

import * as tokenStore from './tokenStore.js';
import { refreshAccessToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

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
let blockedUntil = 0;

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
async function request(path, opts = {}, retry = true) {
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
    const header = Number(resp.headers.get('retry-after'));
    const retryAfterMs = (Number.isFinite(header) && header > 0 ? header : 5) * 1000;
    blockedUntil = Date.now() + retryAfterMs;
    throw new RateLimitError(retryAfterMs);
  }

  if (resp.status === 401 && retry) {
    await refreshAccessToken();
    return request(path, opts, false);
  }
  if (resp.status === 404) {
    // Nos endpoints de player, 404 significa "sem dispositivo ativo".
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
 *   volumePercent: number|null
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
  };
}

function pickCover(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  // images vem ordenado do maior para o menor; pegamos o maior para fatiar bem.
  return images[0].url || '';
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

export async function previous() {
  await request('/me/player/previous', { method: 'POST' });
}

/** Define o volume (0..100). */
export async function setVolume(percent) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  await request(`/me/player/volume?volume_percent=${v}`, { method: 'PUT' });
}
