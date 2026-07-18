// Controle de volume pelo dial (Encoder).
// - Rotação direita/esquerda ajusta o volume em passos.
// - Pressionar o dial alterna mudo/desmudo (guardando o último volume).
//
// As chamadas de volume ao Spotify são debounced: acumulamos o alvo enquanto o
// usuário gira e enviamos apenas a última posição após uma breve pausa.

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as poller from './nowPlayingRegistry.js';

const VOLUME_DIAL = 'com.ulanzi.ulanzistudio.spotifynowplaying.volumeDial';
const STEP = 5;
const DEBOUNCE_MS = 250;

let $UD = null;

// Último volume conhecido, alimentado pelo poller de now playing — evita uma
// chamada extra a getPlaybackState() a cada giro (reduz o risco de rate limit).
let knownVolume = null;

// Estado por-contexto do dial (cada tecla-encoder é independente).
const state = new Map(); // context -> { target:number, timer:any, muted:boolean, preMuteVolume:number }

export function init(ud) {
  $UD = ud;
  // Aproveita as leituras do poller para saber o volume atual sem chamada extra.
  poller.addObserver({
    count: () => 0, // não mantém o poller vivo sozinho
    onState: (s) => {
      if (s && typeof s.volumePercent === 'number') knownVolume = s.volumePercent;
    },
  });
}

export function handles(actionid) {
  return actionid === VOLUME_DIAL;
}

function getState(context) {
  if (!state.has(context)) {
    state.set(context, { target: null, timer: null, muted: false, preMuteVolume: 50 });
  }
  return state.get(context);
}

export function remove(context) {
  const s = state.get(context);
  if (s?.timer) clearTimeout(s.timer);
  state.delete(context);
}

async function currentVolume() {
  // Prefere o volume que o poller já conhece; só consulta a API se não houver.
  if (typeof knownVolume === 'number') return knownVolume;
  const st = await api.getPlaybackState();
  const v = st && typeof st.volumePercent === 'number' ? st.volumePercent : 50;
  knownVolume = v;
  return v;
}

export async function rotate(context, direction) {
  if (!ensureConnected(context)) return;

  const s = getState(context);
  // Base: alvo em andamento, senão o volume atual do dispositivo.
  const base = s.target != null ? s.target : await currentVolume().catch(() => 50);
  const delta = direction === 'right' ? STEP : -STEP;
  s.target = Math.max(0, Math.min(100, base + delta));
  s.muted = false;

  scheduleSend(context);
}

export async function press(context) {
  if (!ensureConnected(context)) return;
  const s = getState(context);
  try {
    if (s.muted) {
      const restore = s.preMuteVolume || 50;
      await api.setVolume(restore);
      s.muted = false;
      s.target = restore;
    } else {
      const cur = await currentVolume();
      s.preMuteVolume = cur > 0 ? cur : s.preMuteVolume || 50;
      await api.setVolume(0);
      s.muted = true;
      s.target = 0;
    }
  } catch (e) {
    reportError(context, e);
  }
}

function scheduleSend(context) {
  const s = getState(context);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(async () => {
    s.timer = null;
    const value = s.target;
    try {
      await api.setVolume(value);
      knownVolume = value; // mantém o valor local em sincronia
    } catch (e) {
      reportError(context, e);
    }
  }, DEBOUNCE_MS);
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
