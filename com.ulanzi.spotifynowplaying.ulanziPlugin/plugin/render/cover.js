// Renderização da capa do álbum para os botões do Deck.
//
// - Single: capa redimensionada ao tamanho de uma tecla → base64 (sem prefixo data:).
// - Mosaico 2x2: a capa é redimensionada para 2*KEY e fatiada em 4 quadrantes,
//   cada um do tamanho de uma tecla, de forma que 4 teclas adjacentes reconstroem
//   a imagem completa.
//
// Resultados são cacheados por URL da capa para evitar re-download/re-processamento
// a cada tick do poller.

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_SIZE = 126; // px por tecla (tamanho renderizado no display do Deck)

// Raiz do plugin, para resolver os assets locais (ícones do manifest).
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Ícones locais já convertidos (assetPath relativo -> base64 PNG).
const localIconCache = new Map();

/**
 * Lê um ícone PNG local do plugin (ex.: 'assets/icons/spotifyLogo.png') e devolve
 * base64 sem prefixo, dimensionado à tecla. Usado como imagem de fundo nos estados
 * sem capa: enviar o ícone por setBaseDataIcon é confiável, enquanto setStateIcon
 * pode deixar a tecla preta depois que ela já exibiu uma capa base64.
 * @param {string} assetPath caminho relativo à raiz do plugin
 * @returns {Promise<string>} base64 do PNG
 */
export async function renderLocalIcon(assetPath) {
  const cached = localIconCache.get(assetPath);
  if (cached) return cached;

  const abs = path.join(PLUGIN_ROOT, assetPath);
  const buf = await sharp(fs.readFileSync(abs))
    .resize(KEY_SIZE, KEY_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const b64 = buf.toString('base64');
  localIconCache.set(assetPath, b64);
  return b64;
}

// Caches separados por finalidade, cada um: coverUrl -> { single, quadrants }.
// Separar evita que o churn de capas do "now playing" (muda a cada música)
// despeje as capas das playlists (fixas), o que reintroduziria o flash.
const caches = {
  // Now playing muda de capa a cada faixa — poucas entradas bastam.
  nowplaying: { store: new Map(), max: 8 },
  // Playlists são fixas por-tecla; cache dimensionado para caber as playlists
  // configuradas sem despejo pelo churn de músicas.
  playlist: { store: new Map(), max: 12 },
};

/** Quadrantes na ordem do layout 2x2. */
export const QUADRANTS = Object.freeze({
  TOP_LEFT: 0,
  TOP_RIGHT: 1,
  BOTTOM_LEFT: 2,
  BOTTOM_RIGHT: 3,
});

async function download(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Falha ao baixar capa: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function build(url) {
  const input = await download(url);

  const single = await sharp(input)
    .resize(KEY_SIZE, KEY_SIZE, { fit: 'cover' })
    .png()
    .toBuffer();

  // Capa 2x maior, depois recortada em 4 quadrantes KEY_SIZE x KEY_SIZE.
  const big = await sharp(input)
    .resize(KEY_SIZE * 2, KEY_SIZE * 2, { fit: 'cover' })
    .png()
    .toBuffer();

  const offsets = [
    { left: 0, top: 0 },
    { left: KEY_SIZE, top: 0 },
    { left: 0, top: KEY_SIZE },
    { left: KEY_SIZE, top: KEY_SIZE },
  ];

  const quadrants = [];
  for (const off of offsets) {
    const buf = await sharp(big)
      .extract({ left: off.left, top: off.top, width: KEY_SIZE, height: KEY_SIZE })
      .png()
      .toBuffer();
    quadrants.push(buf.toString('base64'));
  }

  return { single: single.toString('base64'), quadrants };
}

async function get(url, group) {
  if (!url) throw new Error('URL da capa vazia.');
  const { store, max } = caches[group] || caches.nowplaying;
  if (store.has(url)) return store.get(url);

  const result = await build(url);

  store.set(url, result);
  if (store.size > max) {
    // remove a entrada mais antiga (Map mantém ordem de inserção)
    store.delete(store.keys().next().value);
  }
  return result;
}

/**
 * Base64 (PNG) da capa inteira, dimensionada para uma tecla.
 * @param {string} coverUrl
 * @param {'nowplaying'|'playlist'} [group='nowplaying'] cache a usar
 */
export async function renderSingle(coverUrl, group = 'nowplaying') {
  const { single } = await get(coverUrl, group);
  return single;
}

/**
 * Base64 (PNG) de um quadrante da capa (0..3), para a variante mosaico.
 * @param {string} coverUrl
 * @param {number} quadrant índice 0..3 (ver QUADRANTS)
 * @param {'nowplaying'|'playlist'} [group='nowplaying'] cache a usar
 */
export async function renderQuadrant(coverUrl, quadrant, group = 'nowplaying') {
  const { quadrants } = await get(coverUrl, group);
  const idx = Math.max(0, Math.min(3, Number(quadrant) || 0));
  return quadrants[idx];
}
