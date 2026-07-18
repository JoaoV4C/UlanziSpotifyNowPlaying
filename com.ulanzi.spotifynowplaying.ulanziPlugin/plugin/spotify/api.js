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
  const token = await validToken();
  const resp = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });

  if (resp.status === 401 && retry) {
    await refreshAccessToken();
    return request(path, opts, false);
  }
  if (resp.status === 404) {
    // Nos endpoints de player, 404 significa "sem dispositivo ativo".
    throw new NoActiveDeviceError();
  }
  if (resp.status === 204) {
    return null; // sem conteúdo (ex.: nada tocando)
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Spotify API ${resp.status}: ${txt.slice(0, 200)}`);
  }
  // Alguns endpoints (play/pause/next) respondem 200/202 sem corpo JSON.
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
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
