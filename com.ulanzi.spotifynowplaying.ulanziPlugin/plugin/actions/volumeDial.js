// Controle de volume pelo dial (Encoder) e por botões (Keypad, para o D200 que
// não tem dial).
// - Dial e botões: leem o volume atual do Spotify e aplicam ±STEP. Simples e sem
//   estado acumulado — cada ação parte do volume real, evitando dessincronização.
// - Pressionar o dial alterna mudo/desmudo (guardando o volume anterior).

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';

const VOLUME_DIAL = 'com.ulanzi.ulanzistudio.spotifynowplaying.volumeDial';
const VOLUME_UP = 'com.ulanzi.ulanzistudio.spotifynowplaying.volumeUp';
const VOLUME_DOWN = 'com.ulanzi.ulanzistudio.spotifynowplaying.volumeDown';
const STEP = 10;

let $UD = null;

// Volume guardado antes do mute, por contexto (só o dial usa mute).
const preMuteVolume = new Map();

export function init(ud) {
  $UD = ud;
}

/** Ação de encoder (dial). */
export function handles(actionid) {
  return actionid === VOLUME_DIAL;
}

/** Ações de botão (Keypad): aumentar/diminuir volume, para o D200 sem dial. */
export function handlesKey(actionid) {
  return actionid === VOLUME_UP || actionid === VOLUME_DOWN;
}

/** Trata o toque num botão de volume (evento run). */
export function runKey(context, actionid) {
  const direction = actionid === VOLUME_UP ? 'right' : 'left';
  return rotate(context, direction);
}

export function remove(context) {
  preMuteVolume.delete(context);
}

async function currentVolume() {
  const st = await api.getPlaybackState();
  return st && typeof st.volumePercent === 'number' ? st.volumePercent : 50;
}

/** Lê o volume atual e aplica ±STEP (clamp 0..100). */
export async function rotate(context, direction) {
  if (!ensureConnected(context)) return;
  try {
    const cur = await currentVolume();
    const delta = direction === 'right' ? STEP : -STEP;
    const next = Math.max(0, Math.min(100, cur + delta));
    await api.setVolume(next);
  } catch (e) {
    reportError(context, e);
  }
}

/** Pressionar o dial: alterna mudo/desmudo. */
export async function press(context) {
  if (!ensureConnected(context)) return;
  try {
    const cur = await currentVolume();
    if (cur > 0) {
      preMuteVolume.set(context, cur);
      await api.setVolume(0);
    } else {
      const restore = preMuteVolume.get(context) || 50;
      await api.setVolume(restore);
    }
  } catch (e) {
    reportError(context, e);
  }
}

function ensureConnected(context) {
  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    $UD.showAlert(context);
    return false;
  }
  return true;
}

function reportError(context, e) {
  if (e instanceof RestrictionError) {
    // Dispositivo não permite ajuste de volume via API (ex.: alguns dispositivos
    // Connect). Ignora silenciosamente para não poluir a tecla com erro.
    return;
  }
  if (e instanceof RateLimitError) {
    // Em cooldown do Spotify: ignora silenciosamente.
    return;
  }
  if (e instanceof NoActiveDeviceError) {
    $UD.toast('Nenhum dispositivo Spotify ativo.');
  } else {
    $UD.toast(`Erro de volume: ${e.message}`);
  }
  $UD.showAlert(context);
}
