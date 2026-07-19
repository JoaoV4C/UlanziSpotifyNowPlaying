// Fluxo OAuth Authorization Code + PKCE do Spotify.
//
// O implicit grant foi descontinuado em 2025, e o Spotify não aceita mais
// `localhost` como redirect URI — usamos `http://127.0.0.1:PORT/callback`.
// O usuário deve registrar esse URI exato no dashboard do app dele.

import http from 'node:http';
import crypto from 'node:crypto';
import * as tokenStore from './tokenStore.js';

export const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-library-read', // verificar se a faixa está salva (curtida)
  'user-library-modify', // curtir/descurtir faixas
  'playlist-read-private', // ler nome/capa de playlists privadas do usuário
].join(' ');

// Estado do fluxo de login em andamento (só existe entre "Conectar" e o callback).
let pending = null; // { verifier, state, server, timeout, clientId }

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeVerifier() {
  return base64url(crypto.randomBytes(64)); // ~86 chars, dentro de 43..128
}

function challengeFor(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

/**
 * Inicia o login: sobe o servidor de callback e devolve a URL de autorização
 * que deve ser aberta no navegador. Rejeita se o Client ID não foi informado.
 * @param {string} clientId
 * @returns {Promise<string>} authorizeUrl
 */
export function beginLogin(clientId) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error('Client ID não informado.'));
      return;
    }
    cancelPending();

    const verifier = makeVerifier();
    const state = base64url(crypto.randomBytes(16));

    const server = http.createServer((req, res) => handleCallback(req, res));
    server.on('error', (err) => {
      cancelPending();
      reject(new Error(`Não foi possível abrir a porta ${REDIRECT_PORT}: ${err.message}`));
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      pending = {
        verifier,
        state,
        server,
        clientId,
        timeout: setTimeout(() => cancelPending(), 5 * 60 * 1000), // login expira em 5 min
      };

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        state,
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challengeFor(verifier),
      });
      resolve(`${AUTH_URL}?${params.toString()}`);
    });
  });
}

// Callbacks pós-troca de token: onSuccess() / onError(msg).
let listeners = { onSuccess: () => {}, onError: () => {} };
export function onResult({ onSuccess, onError }) {
  listeners = { onSuccess: onSuccess || (() => {}), onError: onError || (() => {}) };
}

async function handleCallback(req, res) {
  if (!pending) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Nenhum login em andamento.'));
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error || !code || state !== pending.state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Falha na autorização. Pode fechar esta aba e tentar de novo.'));
    finish(false, error || 'Autorização negada ou state inválido.');
    return;
  }

  try {
    const token = await exchangeCode(code, pending.clientId, pending.verifier);
    tokenStore.setToken(token);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Conectado ao Spotify! Pode fechar esta aba e voltar ao UlanziStudio.'));
    finish(true);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Erro ao trocar o código por token. Pode fechar esta aba.'));
    finish(false, e.message);
  }
}

function finish(ok, msg) {
  cancelPending();
  if (ok) listeners.onSuccess();
  else listeners.onError(msg || 'Erro desconhecido.');
}

function cancelPending() {
  if (!pending) return;
  clearTimeout(pending.timeout);
  try {
    pending.server.close();
  } catch {
    /* ignore */
  }
  pending = null;
}

async function exchangeCode(code, clientId, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  return postToken(body);
}

/**
 * Renova o access token usando o refresh token salvo.
 * @returns {Promise<string>} novo access token
 */
export async function refreshAccessToken() {
  const clientId = tokenStore.getClientId();
  const refreshToken = tokenStore.getRefreshToken();
  if (!clientId || !refreshToken) {
    throw new Error('Sem sessão do Spotify. Conecte-se primeiro.');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const token = await postToken(body);
  tokenStore.setToken(token);
  return token.access_token;
}

async function postToken(body) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json.error_description || json.error || `HTTP ${resp.status}`;
    throw new Error(`Spotify token: ${msg}`);
  }
  return json;
}

function page(message) {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8">
<title>Spotify Now Playing</title></head>
<body style="font-family:system-ui;background:#121212;color:#fff;display:flex;
min-height:100vh;align-items:center;justify-content:center;text-align:center;margin:0">
<div><h2 style="color:#1DB954">Spotify Now Playing</h2><p>${message}</p></div></body></html>`;
}
