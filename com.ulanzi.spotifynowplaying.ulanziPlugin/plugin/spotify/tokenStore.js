// Armazena os tokens OAuth do Spotify nas Global Settings do UlanziStudio,
// para que todas as ações do plugin compartilhem a mesma sessão.
//
// O UlanziStudio persiste as Global Settings de forma assíncrona: enviamos com
// setGlobalSettings() e recebemos de volta via onDidReceiveGlobalSettings().
// Este módulo mantém uma cópia em memória e expõe uma Promise que resolve quando
// as settings iniciais chegam.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS_KEY = 'spotifyAuth';
const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.spotifynowplaying';

// O UlanziStudio persiste as global settings em Config/global_settings.json,
// aninhadas sob o UUID do plugin. Lemos esse arquivo como fonte confiável no
// arranque, porque a resposta do getGlobalSettings via WebSocket nem sempre chega.
const GLOBAL_SETTINGS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../Config/global_settings.json'
);

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

  // 1. Fonte confiável: lê o arquivo de global settings persistido pelo Studio.
  loadFromDisk();

  // 2. Também escuta a resposta do WebSocket (mantém em sincronia se mudar em runtime).
  $UD.onDidReceiveGlobalSettings((msg) => {
    const auth = extractAuth(msg?.settings ?? msg?.param ?? {});
    if (auth) {
      cache = { ...cache, ...auth };
    }
    resolveReady();
  });

  $UD.getGlobalSettings();

  // Failsafe: libera o ready mesmo que a resposta do WebSocket não chegue.
  setTimeout(resolveReady, 1200);
}

// Aceita tanto o objeto direto ({ spotifyAuth: {...} }) quanto o aninhado sob o
// UUID do plugin ({ [uuid]: { spotifyAuth: {...} } }), como o Studio persiste.
function extractAuth(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[SETTINGS_KEY] && typeof obj[SETTINGS_KEY] === 'object') return obj[SETTINGS_KEY];
  const nested = obj[PLUGIN_UUID];
  if (nested && typeof nested === 'object' && nested[SETTINGS_KEY]) return nested[SETTINGS_KEY];
  return null;
}

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(GLOBAL_SETTINGS_FILE, 'utf8');
    const auth = extractAuth(JSON.parse(raw));
    if (auth) {
      cache = { ...cache, ...auth };
    }
  } catch {
    // Arquivo ausente ou inválido (ex.: primeira execução) — segue sem sessão.
  }
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
