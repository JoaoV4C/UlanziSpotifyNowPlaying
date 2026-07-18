// Ação "Curtir": salva/remove a faixa atual na biblioteca do Spotify e reflete o
// estado no ícone (como no Spotify): ✓ (check) quando já curtida, + quando não.
//
// O estado de "curtida" é verificado quando a faixa muda (via poller de now
// playing), então o ícone sempre corresponde à música tocando.

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as poller from './nowPlayingRegistry.js';

const LIKE = 'com.ulanzi.ulanzistudio.spotifynowplaying.like';

// Índices de "States" no manifest: 0 = ícone "+" (curtir), 1 = ícone "✓" (curtida).
const ICON_ADD = 0;
const ICON_SAVED = 1;

let $UD = null;

// Teclas "Curtir" ativas.
const contexts = new Set();
// Estado da faixa atual, compartilhado por todas as teclas.
let currentTrackId = null;
let currentSaved = null; // true | false | null (desconhecido)

export function init(ud) {
  $UD = ud;
  // Observa o poller: quando a faixa muda, reverifica se está salva.
  poller.addObserver({
    count: () => contexts.size,
    onState: (state) => onTrack(state?.trackId || null),
  });
}

export function handles(actionid) {
  return actionid === LIKE;
}

/** Registra uma tecla "Curtir". */
export function add(context, actionType) {
  if (actionType !== LIKE) return;
  contexts.add(context);
  applyIcon(context);
  poller.ensureRunning();
}

export function remove(context) {
  contexts.delete(context);
}

// Chamado a cada leitura do poller. Reverifica "salva" apenas quando a faixa muda.
async function onTrack(trackId) {
  if (trackId === currentTrackId) return;
  currentTrackId = trackId;
  currentSaved = null;
  applyIconAll(); // limpa/atualiza enquanto verifica

  if (!trackId || !tokenStore.isConnected()) return;
  try {
    currentSaved = await api.isTrackSaved(trackId);
  } catch {
    currentSaved = null; // falha ao verificar: mantém indefinido
  }
  applyIconAll();
}

/** Toque na tecla: alterna curtir/descurtir a faixa atual. */
export async function run(context) {
  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    $UD.showAlert(context);
    return;
  }
  if (!currentTrackId) {
    $UD.toast('Nada tocando para curtir.');
    return;
  }

  // Se ainda não sabemos, verifica agora.
  if (currentSaved === null) {
    try {
      currentSaved = await api.isTrackSaved(currentTrackId);
    } catch (e) {
      reportError(context, e);
      return;
    }
  }

  const willSave = !currentSaved;
  try {
    if (willSave) await api.saveTrack(currentTrackId);
    else await api.removeTrack(currentTrackId);
    currentSaved = willSave; // atualização otimista
    applyIconAll();
  } catch (e) {
    reportError(context, e);
  }
}

function applyIcon(context) {
  // Sem info ainda: mostra "+" (estado neutro/curtir).
  $UD.setStateIcon(context, currentSaved ? ICON_SAVED : ICON_ADD);
}

function applyIconAll() {
  for (const context of contexts) applyIcon(context);
}

function reportError(context, e) {
  if (e instanceof RateLimitError) return; // cooldown: silencioso
  if (e instanceof RestrictionError) return;
  if (e instanceof NoActiveDeviceError) {
    $UD.toast('Nenhum dispositivo Spotify ativo.');
  } else {
    $UD.toast(`Erro ao curtir: ${e.message}`);
  }
  $UD.showAlert(context);
}
