// Gerencia todas as instâncias de "Now Playing" (single e mosaico) com um único
// poller compartilhado. Ao mudar a faixa, re-renderiza e faz push para cada
// instância ativa. As teclas de controle (play/pause etc.) não passam por aqui.

import { spawn } from 'node:child_process';
import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RateLimitError } from '../spotify/api.js';
import * as cover from '../render/cover.js';
import * as tokenStore from '../spotify/tokenStore.js';

// Intervalo do poller. A 2 s eram ~43 mil requisições/dia com o Studio aberto,
// o que esgotava a cota diária do Spotify: o 429 chegava de madrugada com um
// Retry-After que só expirava no reset da cota (sempre 14:45 UTC), deixando o
// plugin bloqueado o resto da manhã. A 5 s caem para ~17 mil/dia.
// As ações do próprio Deck não ficam mais lentas: next/prev chamam refreshSoon().
const POLL_MS = 5000;

const NOW_PLAYING = 'com.ulanzi.ulanzistudio.spotifynowplaying.nowPlaying';
const MOSAIC = 'com.ulanzi.ulanzistudio.spotifynowplaying.mosaic';

// Ícone padrão de cada tipo (mesma imagem do State 0 do manifest). Sempre que a
// tecla não tem capa para mostrar, exibimos este ícone como base64 — nunca um
// fundo transparente, e sem depender do setStateIcon (que pode pintar a tecla de
// preto depois que ela já exibiu uma capa base64).
const DEFAULT_ICON = {
  single: 'assets/icons/spotifyLogo.png',
  mosaic: 'assets/icons/mosaic.png',
};

let $UD = null;

// context -> { type: 'single'|'mosaic', quadrant?: number }
const instances = new Map();
let timer = null;
let lastTrackId = null;
let lastState = null; // último estado observado (para forçar re-render em novas teclas)

// Leituras vazias consecutivas do /me/player. A API responde vazio de forma
// intermitente com a música tocando, então só tratamos como "parado" depois de
// algumas seguidas (~3 ticks = 6 s).
let emptyReads = 0;
const EMPTY_READS_BEFORE_CLEAR = 3;

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

/**
 * Força uma atualização imediata do Now Playing — usado após next/prev no Deck,
 * para a capa/título trocarem na hora em vez de esperar o próximo tick.
 * Espera um instante para o Spotify refletir a nova faixa antes de reler.
 */
export function refreshSoon(delayMs = 350) {
  if (activeConsumers() === 0) return;
  lastTrackId = null; // força re-render mesmo que o trackId pareça igual
  setTimeout(() => {
    tick().catch(() => {});
  }, delayMs);
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
  // add() vem de onAdd/onSetActive: a página acabou de ficar visível e o Studio
  // pode ter repintado a tecla com o ícone do manifest. Esquecemos o que foi
  // enviado para que o redesenho abaixo realmente aconteça.
  lastSentByContext.delete(context);
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
  lastSentByContext.delete(context); // a tecla sumiu: nada foi enviado a ela
  if (activeConsumers() === 0) stopPolling();
}

/** true se a ação abre o Spotify ao apertar (Now Playing single ou mosaico). */
export function handles(actionType) {
  return actionType === NOW_PLAYING || actionType === MOSAIC;
}

/**
 * Toque na tecla Now Playing: abre/foca o app desktop do Spotify.
 * Usa o protocolo `spotify:` via child_process do Node — o openUrl do Studio
 * abriria no navegador em vez do app.
 */
export function run() {
  openSpotifyApp();
}

function openSpotifyApp() {
  const uri = 'spotify:';
  try {
    let child;
    if (process.platform === 'win32') {
      // 'start' é interno do cmd; o primeiro "" é o título da janela.
      child = spawn('cmd', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [uri], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [uri], { detached: true, stdio: 'ignore' });
    }
    // Erros de spawn são assíncronos (ex.: comando não encontrado no PATH);
    // sem este handler o processo poderia cair com um erro não tratado.
    child.on('error', () => $UD.openUrl('https://open.spotify.com'));
    child.unref();
  } catch {
    // Fallback: pede ao Studio para abrir (abre no navegador, mas melhor que nada).
    $UD.openUrl('https://open.spotify.com');
  }
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
  // Sem poller o estado da tela deixa de ser confiável: força reenvio ao voltar.
  lastSentByContext.clear();
}

async function tick() {
  if (activeConsumers() === 0) return;
  if (!tokenStore.isConnected()) {
    // Idem: o token pode ficar momentaneamente indisponível durante um refresh.
    if (++emptyReads < EMPTY_READS_BEFORE_CLEAR) return;
    pushTextToAll('Conecte\no Spotify');
    notifyObservers(null);
    return;
  }

  let state;
  try {
    state = await api.getPlaybackState();
  } catch (e) {
    if (e instanceof RateLimitError) {
      // Em cooldown do Spotify: não mexe no que está na tela nem insiste.
      // O próprio api bloqueia novas chamadas até o Retry-After expirar.
      return;
    }
    // Falhas transitórias (404 "sem dispositivo ativo", erro de rede) acontecem
    // durante a reprodução normal. Limpar a tela na primeira delas é o que fazia
    // a capa sumir e o ícone de curtir voltar ao padrão, então aqui vale o mesmo
    // filtro das leituras vazias: só reagimos quando a falha se confirma.
    if (++emptyReads < EMPTY_READS_BEFORE_CLEAR) return;

    if (e instanceof NoActiveDeviceError) {
      // Sem dispositivo ativo: mostra o ícone padrão da ação.
      pushDefaultIconToAll();
    } else {
      pushTextToAll('Erro');
    }
    lastTrackId = null;
    notifyObservers(null);
    return;
  }

  if (!state) {
    // O /me/player devolve estado vazio por 1-2 s de forma intermitente, mesmo
    // com a música tocando (confirmado no log: "para NULL" e, 1,7 s depois, de
    // volta à MESMA faixa). Tratar isso como "parou" apagava a capa e resetava o
    // ícone de curtir. Só aceitamos a parada quando ela se confirma em leituras
    // seguidas; até lá mantemos a tela como está.
    if (++emptyReads < EMPTY_READS_BEFORE_CLEAR) return;

    notifyObservers(null);
    pushDefaultIconToAll();
    lastTrackId = null;
    lastState = null;
    return;
  }
  emptyReads = 0;

  // Notifica observadores (ex.: Play/Pause) a cada leitura — o estado de
  // reprodução pode mudar sem a faixa mudar (pausar a mesma música).
  notifyObservers(state);

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

// Última imagem enviada por tecla — reenviar o mesmo base64 não muda nada na
// tela, mas o Studio leva um tempo visível para redecodificar (no mosaico são
// ~140 KB de uma vez) e as teclas ficam vazias durante a repintura.
const lastSentByContext = new Map();

async function renderInstance(context, inst, state) {
  if (!state.coverUrl) {
    setText(context, `${state.title}`);
    return;
  }
  if (inst.type === 'single') {
    const b64 = await cover.renderSingle(state.coverUrl);
    const text = truncate(`${state.title}`);
    const sig = `s:${state.coverUrl}|${text}`;
    if (lastSentByContext.get(context) === sig) return; // nada mudou nesta tecla
    lastSentByContext.set(context, sig);
    $UD.setBaseDataIcon(context, b64, text);
  } else {
    const b64 = await cover.renderQuadrant(state.coverUrl, inst.quadrant);
    const sig = `m:${state.coverUrl}|${inst.quadrant}`;
    if (lastSentByContext.get(context) === sig) return; // nada mudou nesta tecla
    lastSentByContext.set(context, sig);
    // Sem texto no mosaico, para não poluir a imagem reconstruída.
    $UD.setBaseDataIcon(context, b64, '');
  }
}

function pushTextToAll(text) {
  for (const context of instances.keys()) setText(context, text);
}

// Mostra o ícone padrão da tecla com um texto por cima (ou sem texto). Substitui
// o antigo placeholder transparente: a tecla nunca fica "vazia".
function setText(context, text) {
  setDefaultIcon(context, text).catch(() => {});
}

async function setDefaultIcon(context, text = '') {
  const inst = instances.get(context);
  const asset = DEFAULT_ICON[inst?.type] || DEFAULT_ICON.single;
  const sig = `def:${asset}|${text}`;
  // O mesmo guard das capas: estados sem faixa se repetem a cada tick e reenviar
  // o mesmo ícone faria a tecla repiscar durante a repintura do Studio.
  if (lastSentByContext.get(context) === sig) return;
  try {
    const b64 = await cover.renderLocalIcon(asset);
    lastSentByContext.set(context, sig);
    $UD.setBaseDataIcon(context, b64, text);
  } catch {
    // Asset ilegível (não deveria ocorrer): recorre ao State 0 do manifest.
    lastSentByContext.delete(context);
    $UD.setStateIcon(context, 0, text);
  }
}

// Restaura o ícone padrão da ação em todas as teclas. Usado quando nada toca.
function pushDefaultIconToAll() {
  for (const context of instances.keys()) {
    setDefaultIcon(context).catch(() => {});
  }
}

function truncate(s, n = 40) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : s || '';
}
