// Main service do plugin Spotify Now Playing.
// Conecta ao UlanziStudio, carrega a sessão do Spotify e roteia os eventos das
// teclas para os módulos de cada ação.

import UlanziApi from './plugin-common-node/index.js';

import * as tokenStore from './spotify/tokenStore.js';
import * as auth from './spotify/auth.js';
import * as nowPlaying from './actions/nowPlayingRegistry.js';
import * as controls from './actions/controls.js';
import * as volumeDial from './actions/volumeDial.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.spotifynowplaying';
const MOSAIC = 'com.ulanzi.ulanzistudio.spotifynowplaying.mosaic';

const $UD = new UlanziApi();

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => {
  tokenStore.init($UD);
  nowPlaying.init($UD);
  controls.init($UD);
  volumeDial.init($UD);

  // Resultado do fluxo de login → avisa qualquer Property Inspector aberto.
  auth.onResult({
    onSuccess: () => broadcastAuthStatus(),
    onError: (msg) => broadcastAuthStatus(msg),
  });
});

// ---- Ciclo de vida das teclas -------------------------------------------------

$UD.onAdd((msg) => {
  const { context, actionid, param } = normalize(msg);
  nowPlaying.add(context, actionid, param);
});

// setactive: a página/perfil ficou visível novamente — redesenha now playing.
$UD.onSetActive((msg) => {
  const { context, actionid, param } = normalize(msg);
  nowPlaying.add(context, actionid, param);
});

// Configuração alterada no Property Inspector (ex.: quadrante do mosaico).
$UD.onParamFromApp((msg) => {
  const { context, actionid, param } = normalize(msg);
  if (actionid === MOSAIC) nowPlaying.updateSettings(context, param);
});

$UD.onClear((msg) => {
  const list = Array.isArray(msg?.param) ? msg.param : [];
  for (const item of list) {
    const context = item.context;
    if (!context) continue;
    nowPlaying.remove(context);
    volumeDial.remove(context);
  }
});

// ---- Acionamentos -------------------------------------------------------------

function onTrigger(msg) {
  const { context, actionid } = normalize(msg);
  if (controls.handles(actionid)) controls.run(context, actionid);
}
$UD.onRun(onTrigger);
$UD.onKeyUp(onTrigger);

// Encoder (dial de volume)
$UD.onDialRotateLeft((msg) => {
  const { context, actionid } = normalize(msg);
  if (volumeDial.handles(actionid)) volumeDial.rotate(context, 'left');
});
$UD.onDialRotateRight((msg) => {
  const { context, actionid } = normalize(msg);
  if (volumeDial.handles(actionid)) volumeDial.rotate(context, 'right');
});
$UD.onDialDown((msg) => {
  const { context, actionid } = normalize(msg);
  if (volumeDial.handles(actionid)) volumeDial.press(context);
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
    actionid: msg?.actionid || '',
    param: msg?.param || {},
  };
}

// Encerramento limpo.
$UD.onClose(() => {
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
