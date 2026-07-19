// Ação "Playlist": atalho para uma playlist do Spotify. Mostra a capa + nome na
// tecla e, ao ser apertada, começa a tocar a playlist no dispositivo ativo.
//
// A playlist é configurada por-tecla no Property Inspector (cola-se a URL ou URI).

import * as api from '../spotify/api.js';
import { NoActiveDeviceError, RestrictionError, RateLimitError } from '../spotify/api.js';
import * as tokenStore from '../spotify/tokenStore.js';
import * as cover from '../render/cover.js';

const PLAYLIST = 'com.ulanzi.ulanzistudio.spotifynowplaying.playlist';

let $UD = null;

// context -> { playlistId, name, coverUrl }
const instances = new Map();

// Cache dos metadados por playlistId (nome+capa), para não re-buscar na API a
// cada troca de página — o que fazia o ícone piscar.
const metaCache = new Map(); // playlistId -> { name, coverUrl }

export function init(ud) {
  $UD = ud;
}

export function handles(actionid) {
  return actionid === PLAYLIST;
}

/**
 * Extrai o ID da playlist de uma URL/URI colada pelo usuário.
 * Aceita: https://open.spotify.com/playlist/ID?..., spotify:playlist:ID, ou o ID puro.
 * @returns {string} playlistId ou '' se não reconhecido
 */
export function parsePlaylistId(input) {
  if (!input) return '';
  const s = String(input).trim();
  // spotify:playlist:ID
  let m = s.match(/playlist[:/]([A-Za-z0-9]+)/);
  if (m) return m[1];
  // ID puro (base62, 22 chars normalmente)
  if (/^[A-Za-z0-9]{16,}$/.test(s)) return s;
  return '';
}

/** Registra/atualiza uma tecla de playlist (onAdd/onSetActive). */
export async function add(context, actionType, settings = {}) {
  if (actionType !== PLAYLIST) return;
  const playlistId = parsePlaylistId(settings.playlistUrl || settings.playlist || '');

  // Reaproveita metadados já conhecidos (cache) para desenhar na hora, sem piscar.
  const cached = metaCache.get(playlistId);
  instances.set(context, {
    playlistId,
    name: cached?.name || '',
    coverUrl: cached?.coverUrl || '',
  });

  if (cached) {
    await draw(context); // desenha imediatamente com o cache
  } else {
    await refresh(context); // primeira vez: busca na API
  }
}

/** Config alterada no Property Inspector. */
export async function updateSettings(context, settings = {}) {
  const inst = instances.get(context);
  if (!inst) return;
  const playlistId = parsePlaylistId(settings.playlistUrl || settings.playlist || '');
  if (playlistId !== inst.playlistId) {
    inst.playlistId = playlistId;
    inst.name = '';
    inst.coverUrl = '';
    await refresh(context);
  }
}

export function remove(context) {
  instances.delete(context);
}

// Busca nome+capa e desenha a tecla.
async function refresh(context) {
  const inst = instances.get(context);
  if (!inst) return;

  if (!inst.playlistId) {
    // Sem playlist configurada: mostra o ícone padrão da ação (do manifest).
    $UD.setStateIcon(context, 0);
    return;
  }
  if (!tokenStore.isConnected()) {
    setText(context, 'Conecte\no Spotify');
    return;
  }

  try {
    const { name, coverUrl } = await api.getPlaylist(inst.playlistId);
    inst.name = name;
    inst.coverUrl = coverUrl;
    metaCache.set(inst.playlistId, { name, coverUrl }); // guarda p/ próximas trocas de página
    await draw(context);
  } catch (e) {
    if (e instanceof RateLimitError) return; // cooldown: mantém o que está
    setText(context, 'Playlist\ninválida');
  }
}

async function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  if (inst.coverUrl) {
    const b64 = await cover.renderSingle(inst.coverUrl, 'playlist');
    $UD.setBaseDataIcon(context, b64, truncate(inst.name));
  } else {
    setText(context, inst.name || 'Playlist');
  }
}

/** Toque na tecla: toca a playlist. */
export async function run(context) {
  const inst = instances.get(context);
  if (!inst) return;

  if (!tokenStore.isConnected()) {
    $UD.toast('Conecte-se ao Spotify primeiro.');
    return;
  }
  if (!inst.playlistId) {
    $UD.toast('Configure a URL da playlist no botão.');
    return;
  }

  try {
    await api.playContext(`spotify:playlist:${inst.playlistId}`);
  } catch (e) {
    if (e instanceof NoActiveDeviceError) {
      $UD.toast('Abra o Spotify neste computador para usar os comandos.');
    } else if (e instanceof RestrictionError) {
      // ignora
    } else if (e instanceof RateLimitError) {
      $UD.toast('Spotify ocupado, tente em instantes.');
    } else {
      $UD.toast(`Erro ao tocar playlist: ${e.message}`);
    }
  }
}

// PNG 1x1 transparente — fundo neutro quando só há texto.
const TRANSPARENT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function setText(context, text) {
  $UD.setBaseDataIcon(context, TRANSPARENT_PNG_B64, text);
}

function truncate(s, n = 40) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : s || '';
}
