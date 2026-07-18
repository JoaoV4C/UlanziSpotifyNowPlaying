// Gerencia todas as instâncias de "Now Playing" (single e mosaico) com um único
// poller compartilhado. Ao mudar a faixa, re-renderiza e faz push para cada
// instância ativa. As teclas de controle (play/pause etc.) não passam por aqui.

import * as api from '../spotify/api.js';
import { NoActiveDeviceError } from '../spotify/api.js';
import * as cover from '../render/cover.js';
import * as tokenStore from '../spotify/tokenStore.js';

const POLL_MS = 4000;

const NOW_PLAYING = 'com.ulanzi.ulanzistudio.spotifynowplaying.nowPlaying';
const MOSAIC = 'com.ulanzi.ulanzistudio.spotifynowplaying.mosaic';

let $UD = null;

// context -> { type: 'single'|'mosaic', quadrant?: number }
const instances = new Map();
let timer = null;
let lastTrackId = null;
let lastState = null; // último estado observado (para forçar re-render em novas teclas)

// Observadores externos do poller (ex.: botão Play/Pause) que também recebem cada
// leitura do player e podem manter o poller vivo mesmo sem teclas de Now Playing.
// Cada observador: { count: () => número de teclas ativas, onState: (state|null) => void }
const observers = new Set();

export function init(ud) {
  $UD = ud;
}

/** Registra um observador do poller. Retorna uma função para desregistrar. */
export function addObserver(observer) {
  observers.add(observer);
  // Só liga o poller se este observador já tiver teclas ativas; do contrário
  // ele será ligado quando a primeira tecla for adicionada.
  if (activeConsumers() > 0) ensurePolling();
  if (lastState) observer.onState?.(lastState);
  return () => observers.delete(observer);
}

// Total de "consumidores" que justificam manter o poller rodando.
function activeConsumers() {
  let n = instances.size;
  for (const o of observers) n += o.count?.() || 0;
  return n;
}

/** Garante que o poller esteja rodando se houver consumidores. Idempotente. */
export function ensureRunning() {
  if (activeConsumers() > 0) ensurePolling();
}

/** Registra/atualiza uma instância de now playing. `actionType` é o msg.uuid. */
export function add(context, actionType, settings = {}) {
  if (actionType === NOW_PLAYING) {
    instances.set(context, { type: 'single' });
  } else if (actionType === MOSAIC) {
    instances.set(context, { type: 'mosaic', quadrant: Number(settings.quadrant) || 0 });
  } else {
    return;
  }
  lastTrackId = null; // força re-render (inclui a nova tecla) no próximo tick
  ensurePolling();
  // desenha imediatamente com o último estado conhecido, se houver
  if (lastState) renderInstance(context, instances.get(context), lastState).catch(() => {});
}

/** Atualiza os settings (ex.: quadrante do mosaico) de uma instância existente. */
export function updateSettings(context, settings = {}) {
  const inst = instances.get(context);
  if (!inst) return;
  if (inst.type === 'mosaic') {
    inst.quadrant = Number(settings.quadrant) || 0;
    if (lastState) renderInstance(context, inst, lastState).catch(() => {});
  }
}

/** Remove uma instância (tecla limpa). */
export function remove(context) {
  instances.delete(context);
  if (activeConsumers() === 0) stopPolling();
}

function ensurePolling() {
  if (timer) return;
  tick(); // primeira leitura imediata
  timer = setInterval(tick, POLL_MS);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  lastTrackId = null;
  lastState = null;
}

async function tick() {
  if (activeConsumers() === 0) return;
  if (!tokenStore.isConnected()) {
    pushTextToAll('Conecte\no Spotify');
    notifyObservers(null);
    return;
  }

  let state;
  try {
    state = await api.getPlaybackState();
  } catch (e) {
    if (e instanceof NoActiveDeviceError) {
      pushTextToAll('Sem\ndispositivo');
    } else {
      pushTextToAll('Erro');
    }
    lastTrackId = null;
    notifyObservers(null);
    return;
  }

  // Notifica observadores (ex.: Play/Pause) a cada leitura — o estado de
  // reprodução pode mudar sem a faixa mudar (pausar a mesma música).
  notifyObservers(state);

  if (!state) {
    pushTextToAll('Nada\ntocando');
    lastTrackId = null;
    lastState = null;
    return;
  }

  lastState = state;
  // Só re-renderiza imagens quando a faixa muda (evita reprocessar a capa toda hora).
  if (state.trackId === lastTrackId) return;
  lastTrackId = state.trackId;

  for (const [context, inst] of instances) {
    await renderInstance(context, inst, state).catch(() => {});
  }
}

function notifyObservers(state) {
  for (const o of observers) {
    try {
      o.onState?.(state);
    } catch {
      /* observador não deve interromper o poller */
    }
  }
}

async function renderInstance(context, inst, state) {
  if (!state.coverUrl) {
    setText(context, `${state.title}`);
    return;
  }
  if (inst.type === 'single') {
    const b64 = await cover.renderSingle(state.coverUrl);
    $UD.setBaseDataIcon(context, b64, truncate(`${state.title}`));
  } else {
    const b64 = await cover.renderQuadrant(state.coverUrl, inst.quadrant);
    // Sem texto no mosaico, para não poluir a imagem reconstruída.
    $UD.setBaseDataIcon(context, b64, '');
  }
}

function pushTextToAll(text) {
  for (const context of instances.keys()) setText(context, text);
}

function setText(context, text) {
  // Placeholder textual: usamos setBaseDataIcon com um PNG 1x1 transparente + texto,
  // mas o SDK também aceita showtext via textData. Aqui apenas mostramos o texto.
  $UD.setBaseDataIcon(context, TRANSPARENT_PNG_B64, text);
}

function truncate(s, n = 40) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : s || '';
}

// PNG 1x1 transparente (base64) — fundo neutro quando só há texto para mostrar.
const TRANSPARENT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
