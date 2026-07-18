// Main service do plugin Spotify Now Playing.
// Conecta ao UlanziStudio, carrega a sessão do Spotify e roteia os eventos das
// teclas para os módulos de cada ação.

import UlanziApi from './plugin-common-node/index.js';
import './diaglog.js'; // registra captura de erros não tratados

import * as tokenStore from './spotify/tokenStore.js';
import * as auth from './spotify/auth.js';
import * as nowPlaying from './actions/nowPlayingRegistry.js';
import * as controls from './actions/controls.js';
import * as volumeDial from './actions/volumeDial.js';
import * as likeTrack from './actions/likeTrack.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.spotifynowplaying';
const MOSAIC = 'com.ulanzi.ulanzistudio.spotifynowplaying.mosaic';

const $UD = new UlanziApi();

// Estado da (re)conexão ao bridge do Studio.
let reconnectDelay = 1000; // ms; resetado para 1s a cada conexão bem-sucedida
const MAX_RECONNECT_DELAY = 30000;
let shuttingDown = false;
let reconnectTimer = null;

// Inicializa os módulos uma única vez (mesmo que o socket reconecte depois).
let initialized = false;
function setupOnce() {
  if (initialized) return;
  initialized = true;

  tokenStore.init($UD);
  nowPlaying.init($UD);
  controls.init($UD);
  volumeDial.init($UD);
  likeTrack.init($UD);

  // Resultado do fluxo de login → avisa qualquer Property Inspector aberto.
  auth.onResult({
    onSuccess: () => broadcastAuthStatus(),
    onError: (msg) => broadcastAuthStatus(msg),
  });
}

$UD.onConnected(() => {
  reconnectDelay = 1000; // conexão OK: zera o backoff
  setupOnce();
});

// Sem este handler, o emit('error') do SDK (EventEmitter) derruba o processo com
// ERR_UNHANDLED_ERROR quando o bridge do Studio oscila. Aqui apenas registramos;
// a reconexão é tratada em onClose.
$UD.onError((err) => {
  console.error('[spotify-now-playing] WS error:', typeof err === 'string' ? err : JSON.stringify(err));
});

$UD.connect(PLUGIN_UUID);

// ---- Ciclo de vida das teclas -------------------------------------------------

$UD.onAdd((msg) => {
  const { context, actionType, param } = normalize(msg);
  nowPlaying.add(context, actionType, param);
  controls.add(context, actionType);
  likeTrack.add(context, actionType);
});

// setactive: a página/perfil ficou visível novamente — redesenha now playing.
$UD.onSetActive((msg) => {
  const { context, actionType, param } = normalize(msg);
  nowPlaying.add(context, actionType, param);
  controls.add(context, actionType);
  likeTrack.add(context, actionType);
});

// Configuração alterada no Property Inspector (ex.: quadrante do mosaico).
$UD.onParamFromApp((msg) => {
  const { context, actionType, param } = normalize(msg);
  if (actionType === MOSAIC) nowPlaying.updateSettings(context, param);
});

$UD.onClear((msg) => {
  const list = Array.isArray(msg?.param) ? msg.param : [];
  for (const item of list) {
    const context = item.context;
    if (!context) continue;
    nowPlaying.remove(context);
    volumeDial.remove(context);
    controls.remove(context);
    likeTrack.remove(context);
  }
});

// ---- Acionamentos -------------------------------------------------------------

function onTrigger(msg) {
  const { context, actionType } = normalize(msg);
  if (controls.handles(actionType)) controls.run(context, actionType);
  else if (volumeDial.handlesKey(actionType)) volumeDial.runKey(context, actionType);
  else if (likeTrack.handles(actionType)) likeTrack.run(context);
}
// Apenas `run` — cada toque emite `run` E `keyup`; ouvir os dois dobraria o
// comando (pulava 2 faixas em next/prev).
$UD.onRun(onTrigger);

// Encoder (dial de volume)
$UD.onDialRotateLeft((msg) => {
  const { context, actionType } = normalize(msg);
  if (volumeDial.handles(actionType)) volumeDial.rotate(context, 'left');
});
$UD.onDialRotateRight((msg) => {
  const { context, actionType } = normalize(msg);
  if (volumeDial.handles(actionType)) volumeDial.rotate(context, 'right');
});
$UD.onDialDown((msg) => {
  const { context, actionType } = normalize(msg);
  if (volumeDial.handles(actionType)) volumeDial.press(context);
});

// ---- Comunicação com os Property Inspectors ----------------------------------
// O PI de Auth manda ações via sendToPlugin; respondemos via sendToPropertyInspector.

$UD.onSendToPlugin(async (msg) => {
  const payload = msg?.payload || {};
  const context = msg?.context || $UD.encodeContext(msg);

  switch (payload.action) {
    case 'getAuthStatus':
      sendAuthStatus(context);
      break;
    case 'setClientId':
      tokenStore.setClientId(payload.clientId || '');
      sendAuthStatus(context);
      break;
    case 'login':
      await startLogin(context, payload.clientId);
      break;
    case 'logout':
      tokenStore.clear();
      broadcastAuthStatus();
      break;
    default:
      break;
  }
});

async function startLogin(context, clientId) {
  const id = clientId || tokenStore.getClientId();
  if (clientId) tokenStore.setClientId(clientId);
  await tokenStore.whenReady();
  try {
    const url = await auth.beginLogin(id);
    $UD.openUrl(url); // abre o navegador na tela de consentimento do Spotify
    $UD.sendToPropertyInspector(
      { action: 'authStatus', status: 'pending', clientId: id, redirectUri: auth.REDIRECT_URI },
      context
    );
  } catch (e) {
    $UD.sendToPropertyInspector(
      { action: 'authStatus', status: 'error', message: e.message, redirectUri: auth.REDIRECT_URI },
      context
    );
  }
}

function sendAuthStatus(context, message) {
  $UD.sendToPropertyInspector(
    {
      action: 'authStatus',
      status: tokenStore.isConnected() ? 'connected' : 'disconnected',
      clientId: tokenStore.getClientId(),
      redirectUri: auth.REDIRECT_URI,
      message: message || '',
    },
    context
  );
}

// Sem um context específico: manda para o PI ativo usando o context corrente do SDK.
function broadcastAuthStatus(message) {
  const context = $UD.encodeContext({
    uuid: $UD.uuid,
    key: $UD.key,
    actionid: $UD.actionid,
  });
  sendAuthStatus(context, message);
}

// ---- Utilidades ---------------------------------------------------------------

function normalize(msg) {
  return {
    context: msg?.context || (msg ? $UD.encodeContext(msg) : ''),
    // O tipo da ação (o que casa com o manifest) vem em `uuid`.
    // `actionid` é um GUID por-instância gerado pelo Studio — não serve para rotear.
    actionType: msg?.uuid || '',
    param: msg?.param || {},
  };
}

// Reconexão: quando o bridge do Studio cai (reinício/oscilação), tenta reconectar
// com backoff exponencial em vez de encerrar o processo. Assim o plugin sobrevive
// a reinícios do Studio e o botão "Conectar" volta a responder sem precisar
// relançar o main service.
$UD.onClose(() => {
  if (shuttingDown) return;
  if (reconnectTimer) return; // já há uma tentativa agendada
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      $UD.connect(PLUGIN_UUID);
    } catch (e) {
      console.error('[spotify-now-playing] reconnect failed:', e?.message);
    }
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
});

function shutdown() {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
