// Ação "Repetir": percorre os modos de repetição do Spotify e reflete o modo no
// ícone — apagado (off), destacado (repetir tudo) e com "1" (repetir a faixa).
//
// O modo vem do poller de now playing (campo `repeatMode` do player), então o
// ícone acompanha mudanças feitas por fora (ex.: pelo app do Spotify).

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as poller from './nowPlayingRegistry.js';

const REPEAT = 'com.ulanzi.ulanzistudio.spotifynowplaying.repeat';

// Índices de "States" no manifest, na ordem do ciclo:
// 0 = off, 1 = context (repetir playlist/álbum), 2 = track (repetir a faixa).
const ICON_BY_MODE = { off: 0, context: 1, track: 2 };

let $UD = null;

// Teclas de repetição ativas e o último modo conhecido (compartilhado).
const contexts = new Set();
let currentMode = null; // 'off' | 'context' | 'track' | null (desconhecido)

export function init(ud) {
  $UD = ud;
  // Observa o poller para refletir o modo mesmo quando muda por fora.
  poller.addObserver({
    count: () => contexts.size,
    onState: (state) => {
      if (state) updateRepeatMode(state.repeatMode);
    },
  });
}

export function handles(actionid) {
  return actionid === REPEAT;
}

/** Registra uma tecla de repetição (onAdd/onSetActive). */
export function add(context, actionType) {
  if (actionType !== REPEAT) return;
  contexts.add(context);
  applyIcon(context);
  poller.ensureRunning(); // mantém o modo atualizado periodicamente
}

export function remove(context) {
  contexts.delete(context);
}

/** Atualiza o ícone de todas as teclas conforme o modo de repetição. */
export function updateRepeatMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  for (const context of contexts) applyIcon(context);
}

function applyIcon(context) {
  // Sem info ainda: mostra "off" (estado neutro).
  $UD.setStateIcon(context, ICON_BY_MODE[currentMode] ?? ICON_BY_MODE.off);
}

/** Toque na tecla: avança para o próximo modo de repetição. */
export async function run(context) {
  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    return;
  }

  try {
    const mode = await api.cycleRepeat();
    updateRepeatMode(mode); // reflete o novo modo no ícone na hora
  } catch (e) {
    if (e instanceof RestrictionError) return; // dispositivo não permite: ignora
    if (e instanceof RateLimitError) {
      $UD.toast('Spotify ocupado, tente em instantes.');
      return;
    }
    if (e instanceof NoActiveDeviceError) {
      $UD.toast('Abra o Spotify neste computador.');
    } else {
      $UD.toast(`Erro na repetição: ${e.message}`);
    }
  }
}
