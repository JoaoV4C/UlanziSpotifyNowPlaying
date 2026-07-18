// Ações de controle de playback: Play/Pause, Próxima, Anterior.
// Todas exigem conta Premium e um dispositivo Spotify ativo.

import * as api from '../spotify/api.js';
import { NoActiveDeviceError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';

const PLAY_PAUSE = 'com.ulanzi.ulanzistudio.spotifynowplaying.playPause';
const NEXT = 'com.ulanzi.ulanzistudio.spotifynowplaying.nextTrack';
const PREV = 'com.ulanzi.ulanzistudio.spotifynowplaying.prevTrack';

let $UD = null;

export function init(ud) {
  $UD = ud;
}

export function handles(actionid) {
  return actionid === PLAY_PAUSE || actionid === NEXT || actionid === PREV;
}

/** Trata o acionamento de uma tecla de controle (evento run/keyUp). */
export async function run(context, actionid) {
  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    $UD.showAlert(context);
    return;
  }

  try {
    if (actionid === PLAY_PAUSE) {
      await api.togglePlayPause();
    } else if (actionid === NEXT) {
      await api.next();
    } else if (actionid === PREV) {
      await api.previous();
    }
  } catch (e) {
    if (e instanceof NoActiveDeviceError) {
      $UD.toast('Nenhum dispositivo Spotify ativo. Abra o Spotify e toque algo.');
    } else {
      $UD.toast(`Erro: ${e.message}`);
    }
    $UD.showAlert(context);
  }
}
