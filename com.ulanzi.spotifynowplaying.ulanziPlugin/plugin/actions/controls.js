// Ações de controle de playback: Play/Pause, Próxima, Anterior.
// Todas exigem conta Premium e um dispositivo Spotify ativo.

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as poller from './nowPlayingRegistry.js';

const PLAY_PAUSE = 'com.ulanzi.ulanzistudio.spotifynowplaying.playPause';
const NEXT = 'com.ulanzi.ulanzistudio.spotifynowplaying.nextTrack';
const PREV = 'com.ulanzi.ulanzistudio.spotifynowplaying.prevTrack';

// Índices de "States" no manifest: 0 = ícone de play, 1 = ícone de pause.
// O botão mostra o ícone da AÇÃO que o toque fará (não do estado atual):
//   tocando  -> mostra PAUSE (o toque vai pausar)
//   pausado  -> mostra PLAY  (o toque vai tocar)
const ICON_PLAY = 0;
const ICON_PAUSE = 1;

let $UD = null;

// Contextos das teclas Play/Pause ativas, para refletir o estado de reprodução.
const playPauseContexts = new Set();
let lastIsPlaying = null;

export function init(ud) {
  $UD = ud;
  // Observa o poller para refletir play/pause mesmo quando a mudança vem de fora
  // (ex.: o usuário pausa pelo celular) e para manter o poller vivo se houver
  // apenas teclas Play/Pause na tela.
  poller.addObserver({
    count: () => playPauseContexts.size,
    onState: (state) => {
      if (state) updatePlayState(state.isPlaying);
    },
  });
}

export function handles(actionid) {
  return actionid === PLAY_PAUSE || actionid === NEXT || actionid === PREV;
}

/** Registra uma tecla Play/Pause (chamado no onAdd/onSetActive). */
export function add(context, actionType) {
  if (actionType !== PLAY_PAUSE) return;
  playPauseContexts.add(context);
  // Aplica o estado conhecido imediatamente; se nenhum, assume tocando.
  applyState(context, lastIsPlaying ?? true);
  poller.ensureRunning(); // garante que o estado seja atualizado periodicamente
}

/** Remove uma tecla Play/Pause (chamado no onClear). */
export function remove(context) {
  playPauseContexts.delete(context);
}

/**
 * Atualiza o ícone de todas as teclas Play/Pause conforme o estado atual.
 * Chamado pelo poller de now playing a cada leitura do player.
 */
export function updatePlayState(isPlaying) {
  if (isPlaying === lastIsPlaying) return;
  lastIsPlaying = isPlaying;
  for (const context of playPauseContexts) applyState(context, isPlaying);
}

function applyState(context, isPlaying) {
  // Ícone da ação: tocando -> pause; pausado -> play.
  $UD.setStateIcon(context, isPlaying ? ICON_PAUSE : ICON_PLAY);
}

// Último acionamento por contexto, para descartar toques duplicados muito
// próximos (defesa extra contra eventos repetidos do Studio/firmware).
const lastRunAt = new Map();
const DEBOUNCE_MS = 400;

/** Trata o acionamento de uma tecla de controle (evento run). */
export async function run(context, actionid) {
  const now = Date.now();
  if (now - (lastRunAt.get(context) || 0) < DEBOUNCE_MS) return;
  lastRunAt.set(context, now);

  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    $UD.showAlert(context);
    return;
  }

  try {
    if (actionid === PLAY_PAUSE) {
      const nowPlaying = await api.togglePlayPause();
      updatePlayState(nowPlaying); // reflete o novo estado no ícone na hora
    } else if (actionid === NEXT) {
      await api.next();
    } else if (actionid === PREV) {
      await api.previous();
    }
  } catch (e) {
    if (e instanceof RestrictionError) {
      // Comando recusado no contexto atual (ex.: "anterior" no início da faixa).
      // Não é falha de configuração — não mostramos ícone de erro.
      return;
    }
    if (e instanceof RateLimitError) {
      // Em cooldown do Spotify: avisa de leve, sem ícone de erro na tecla.
      $UD.toast('Spotify ocupado, tente em instantes.');
      return;
    }
    if (e instanceof NoActiveDeviceError) {
      $UD.toast('Nenhum dispositivo Spotify ativo. Abra o Spotify e toque algo.');
    } else {
      $UD.toast(`Erro: ${e.message}`);
    }
    $UD.showAlert(context);
  }
}
