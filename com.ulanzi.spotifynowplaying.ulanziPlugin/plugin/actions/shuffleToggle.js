// Ação "Aleatório": liga/desliga o modo shuffle do Spotify e reflete o estado no
// ícone (apagado quando desligado, destacado quando ligado).
//
// O estado vem do poller de now playing (campo `shuffle` do player), então o
// ícone acompanha mudanças feitas por fora (ex.: pelo app do Spotify).

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as poller from './nowPlayingRegistry.js';

const SHUFFLE = 'com.ulanzi.ulanzistudio.spotifynowplaying.shuffle';

// Índices de "States" no manifest: 0 = desligado, 1 = ligado.
const ICON_OFF = 0;
const ICON_ON = 1;

let $UD = null;

// Teclas de shuffle ativas e o último estado conhecido (compartilhado).
const contexts = new Set();
let currentShuffle = null; // true | false | null (desconhecido)

export function init(ud) {
  $UD = ud;
  // Observa o poller para refletir o shuffle mesmo quando muda por fora.
  poller.addObserver({
    count: () => contexts.size,
    onState: (state) => {
      if (state) updateShuffleState(state.shuffle);
    },
  });
}

export function handles(actionid) {
  return actionid === SHUFFLE;
}

/** Registra uma tecla de shuffle (onAdd/onSetActive). */
export function add(context, actionType) {
  if (actionType !== SHUFFLE) return;
  contexts.add(context);
  applyIcon(context);
  poller.ensureRunning(); // mantém o estado atualizado periodicamente
}

export function remove(context) {
  contexts.delete(context);
}

/** Atualiza o ícone de todas as teclas conforme o estado do shuffle. */
export function updateShuffleState(shuffle) {
  if (shuffle === currentShuffle) return;
  currentShuffle = shuffle;
  for (const context of contexts) applyIcon(context);
}

function applyIcon(context) {
  $UD.setStateIcon(context, currentShuffle ? ICON_ON : ICON_OFF);
}

/** Toque na tecla: alterna o modo aleatório. */
export async function run(context) {
  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    return;
  }

  try {
    const now = await api.toggleShuffle();
    updateShuffleState(now); // reflete o novo estado no ícone na hora
  } catch (e) {
    if (e instanceof RestrictionError) return; // dispositivo não permite: ignora
    if (e instanceof RateLimitError) {
      $UD.toast('Spotify ocupado, tente em instantes.');
      return;
    }
    if (e instanceof NoActiveDeviceError) {
      $UD.toast('Abra o Spotify neste computador.');
    } else {
      $UD.toast(`Erro no aleatório: ${e.message}`);
    }
  }
}
