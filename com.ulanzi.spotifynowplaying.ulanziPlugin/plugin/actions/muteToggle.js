// Ação "Mudo": silencia o Spotify e, ao apertar de novo, restaura o volume
// anterior — como o botão de mudo do próprio Spotify.
//
// A Web API não tem um endpoint de mute: mutar é definir volume 0, e desmutar é
// restaurar o volume que havia antes. Guardamos esse volume em memória (mesma
// abordagem do plugin oficial da Ulanzi), com 50% como fallback caso o valor não
// seja conhecido (ex.: o plugin reiniciou enquanto estava mudo).
//
// O ícone segue o volume real reportado pelo poller, então acompanha mudanças
// feitas por fora (ex.: mutar pelo app do Spotify).

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as poller from './nowPlayingRegistry.js';

const MUTE = 'com.ulanzi.ulanzistudio.spotifynowplaying.mute';

// Índices de "States" no manifest: 0 = com som, 1 = mudo.
const ICON_UNMUTED = 0;
const ICON_MUTED = 1;

// Volume restaurado quando não sabemos o valor anterior.
const FALLBACK_VOLUME = 50;

let $UD = null;

// Teclas de mudo ativas e o último estado conhecido (compartilhado).
const contexts = new Set();
let isMuted = null; // true | false | null (desconhecido)
// Volume de antes do mute, para restaurar ao desmutar.
let volumeBeforeMute = null;

export function init(ud) {
  $UD = ud;
  // Observa o poller: volume 0 significa mudo. Assim o ícone acompanha o app.
  poller.addObserver({
    count: () => contexts.size,
    onState: (state) => {
      if (!state || typeof state.volumePercent !== 'number') return;
      // Memoriza o último volume audível, para restaurar depois.
      if (state.volumePercent > 0) volumeBeforeMute = state.volumePercent;
      updateMuted(state.volumePercent === 0);
    },
  });
}

export function handles(actionid) {
  return actionid === MUTE;
}

/** Registra uma tecla de mudo (onAdd/onSetActive). */
export function add(context, actionType) {
  if (actionType !== MUTE) return;
  contexts.add(context);
  applyIcon(context);
  poller.ensureRunning(); // mantém o estado atualizado periodicamente
}

export function remove(context) {
  contexts.delete(context);
}

/** Atualiza o ícone de todas as teclas conforme o estado de mudo. */
export function updateMuted(muted) {
  if (muted === isMuted) return;
  isMuted = muted;
  for (const context of contexts) applyIcon(context);
}

function applyIcon(context) {
  $UD.setStateIcon(context, isMuted ? ICON_MUTED : ICON_UNMUTED);
}

/** Toque na tecla: silencia ou restaura o volume anterior. */
export async function run(context) {
  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    return;
  }

  try {
    const state = await api.getPlaybackState();
    const current = typeof state?.volumePercent === 'number' ? state.volumePercent : FALLBACK_VOLUME;

    if (current > 0) {
      volumeBeforeMute = current; // guarda para restaurar depois
      await api.setVolume(0);
      updateMuted(true);
    } else {
      const restore = volumeBeforeMute || FALLBACK_VOLUME;
      await api.setVolume(restore);
      updateMuted(false);
    }
  } catch (e) {
    if (e instanceof RestrictionError) return; // dispositivo não permite: ignora
    if (e instanceof RateLimitError) {
      $UD.toast('Spotify ocupado, tente em instantes.');
      return;
    }
    if (e instanceof NoActiveDeviceError) {
      $UD.toast('Abra o Spotify neste computador.');
    } else {
      $UD.toast(`Erro ao silenciar: ${e.message}`);
    }
  }
}
