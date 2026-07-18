// Armazena os tokens OAuth do Spotify nas Global Settings do UlanziStudio,
// para que todas as ações do plugin compartilhem a mesma sessão.
//
// O UlanziStudio persiste as Global Settings de forma assíncrona: enviamos com
// setGlobalSettings() e recebemos de volta via onDidReceiveGlobalSettings().
// Este módulo mantém uma cópia em memória e expõe uma Promise que resolve quando
// as settings iniciais chegam.

const SETTINGS_KEY = 'spotifyAuth';

let $UD = null;
let cache = { clientId: '', accessToken: '', refreshToken: '', expiresAt: 0 };

let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});

/**
 * Liga o store ao SDK. Deve ser chamado uma vez, após $UD.connect().
 * @param {import('../plugin-common-node/index.js').UlanziApi} ud
 */
export function init(ud) {
  $UD = ud;

  $UD.onDidReceiveGlobalSettings((msg) => {
    const settings = msg?.settings ?? msg?.param ?? {};
    const auth = settings[SETTINGS_KEY];
    if (auth && typeof auth === 'object') {
      cache = { ...cache, ...auth };
    }
    resolveReady();
  });

  // Pede as settings salvas; a resposta chega no handler acima.
  $UD.getGlobalSettings();

  // Failsafe: se o app não responder (ex. primeira execução sem settings salvas),
  // libera o ready mesmo assim depois de um curto intervalo.
  setTimeout(resolveReady, 1500);
}

/** Aguarda o carregamento inicial das settings. */
export function whenReady() {
  return ready;
}

export function getClientId() {
  return cache.clientId || '';
}

export function getRefreshToken() {
  return cache.refreshToken || '';
}

export function getAccessToken() {
  return cache.accessToken || '';
}

/** true se há um access token que ainda não expirou (com margem de 30s). */
export function hasValidAccessToken() {
  return Boolean(cache.accessToken) && Date.now() < cache.expiresAt - 30_000;
}

/** true se há credenciais suficientes para renovar/usar a sessão. */
export function isConnected() {
  return Boolean(cache.refreshToken);
}

/** Persiste o Client ID (informado pelo usuário no Property Inspector). */
export function setClientId(clientId) {
  cache.clientId = clientId || '';
  persist();
}

/**
 * Guarda o resultado de uma troca/refresh de token.
 * @param {{access_token:string, refresh_token?:string, expires_in:number}} token
 */
export function setToken(token) {
  cache.accessToken = token.access_token || '';
  if (token.refresh_token) {
    cache.refreshToken = token.refresh_token;
  }
  const expiresInMs = (token.expires_in || 3600) * 1000;
  cache.expiresAt = Date.now() + expiresInMs;
  persist();
}

/** Limpa a sessão (logout). */
export function clear() {
  cache = { clientId: cache.clientId, accessToken: '', refreshToken: '', expiresAt: 0 };
  persist();
}

function persist() {
  if (!$UD) return;
  $UD.setGlobalSettings({ [SETTINGS_KEY]: cache });
}
