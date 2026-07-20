// Testes de regressão do tratamento de rate limit (429) do Spotify.
//
// Cobrem os problemas reais que já derrubaram o plugin em produção:
//  1. Não respeitar o Retry-After e continuar batendo na API (o Spotify ESTENDE
//     o bloqueio, que chegou a ~12h).
//  2. Zerar o cooldown por causa de uma resposta OK qualquer (ex.: /devices),
//     fazendo o plugin voltar a martelar a API durante o bloqueio.
//  3. Perder o cooldown ao reiniciar o processo.
//
// Executa com: node --test test/
//
// Estratégia: exercitamos o api.js REAL, interceptando o fetch global e
// injetando um token válido no tokenStore (nada de rede nem de credenciais).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const BLOCK_FILE = path.join(PLUGIN_DIR, 'plugin', 'ratelimit.json');

// ---- utilidades de teste ------------------------------------------------------

/** Remove o arquivo de cooldown para começar cada teste do zero. */
function clearBlockFile() {
  try {
    fs.unlinkSync(BLOCK_FILE);
  } catch {
    /* já não existe */
  }
}

/** Escreve um cooldown no disco, como se um 429 tivesse acontecido antes. */
function writeBlockFile(blockedUntil) {
  fs.writeFileSync(BLOCK_FILE, JSON.stringify({ blockedUntil }));
}

/**
 * Importa uma instância nova do api.js (cada import com query única burla o
 * cache de módulos do Node), com um token válido injetado e o fetch mockado.
 *
 * @param {(url: string, opts: object) => Response} handler resposta por requisição
 * @returns {Promise<{ api: object, calls: string[] }>}
 */
async function loadApi(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${String(url).replace('https://api.spotify.com/v1', '')}`);
    return handler(String(url), opts);
  };

  // O api.js importa './tokenStore.js' sem query, então injetamos o token nessa
  // mesma instância (a que ele enxerga) antes de carregá-lo.
  const tokenStore = await import('../plugin/spotify/tokenStore.js');
  // Token válido por 1h: evita que o request tente renovar (o que exigiria rede).
  tokenStore.setToken({ access_token: 'test-token', expires_in: 3600 });

  // Query única força uma instância nova do api.js — o `blockedUntil` volta a ser
  // lido do disco, como aconteceria num reinício do processo.
  const api = await import(`../plugin/spotify/api.js?t=${Date.now()}-${Math.random()}`);
  return { api, calls };
}

/** Resposta 429 com Retry-After (segundos). */
function tooManyRequests(retryAfterSeconds) {
  return new Response('{}', {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds), 'content-type': 'application/json' },
  });
}

/** Resposta OK com corpo JSON de player. */
function playerOk(body = {}) {
  return new Response(
    JSON.stringify({
      is_playing: true,
      shuffle_state: false,
      repeat_state: 'off',
      progress_ms: 1000,
      device: { id: 'dev1', volume_percent: 50, is_active: true },
      item: { id: 'track1', name: 'Song', artists: [], album: { images: [] } },
      ...body,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// ---- testes -------------------------------------------------------------------

test('429 respeita o Retry-After e bloqueia novas requisições', async () => {
  clearBlockFile();
  const { api, calls } = await loadApi(() => tooManyRequests(120));

  // 1ª chamada: recebe o 429 e registra o bloqueio.
  await assert.rejects(() => api.getPlaybackState(), { name: 'RateLimitError' });
  assert.equal(calls.length, 1, 'a 1ª chamada deve ir à rede');

  // O cooldown ficou ativo, com ~120s restantes.
  const remaining = api.rateLimitRemainingMs();
  assert.ok(remaining > 110_000 && remaining <= 120_000, `restante inesperado: ${remaining}`);

  // REGRESSÃO: chamadas seguintes NÃO podem tocar a rede — insistir estende o bloqueio.
  await assert.rejects(() => api.getPlaybackState(), { name: 'RateLimitError' });
  await assert.rejects(() => api.next(), { name: 'RateLimitError' });
  assert.equal(calls.length, 1, 'durante o cooldown nenhuma requisição deve ser enviada');
});

test('resposta OK concorrente NÃO cancela um cooldown recém-criado', async () => {
  // REGRESSÃO (o bug que causou o bloqueio de ~12h): o poller e as ações disparam
  // em paralelo. Uma requisição leva 429 e grava o cooldown; outra, JÁ EM VOO,
  // volta 200 e — na lógica antiga — zerava o bloqueio. O plugin então voltava a
  // martelar a API a cada tick e o Spotify estendia a punição.
  clearBlockFile();

  let resolveSlow;
  const slowOk = new Promise((r) => {
    resolveSlow = r;
  });

  // A 1ª requisição (lenta) responderá 200 DEPOIS que a 2ª receber o 429.
  let n = 0;
  const { api } = await loadApi(() => {
    n += 1;
    return n === 1 ? slowOk : tooManyRequests(300);
  });

  const emVoo = api.getPlaybackState().catch(() => 'falhou'); // fica pendente
  await assert.rejects(() => api.next(), { name: 'RateLimitError' }); // grava o cooldown

  const bloqueioAntes = api.rateLimitRemainingMs();
  assert.ok(bloqueioAntes > 0, 'o 429 deve ter criado o cooldown');

  resolveSlow(playerOk()); // a resposta OK chega agora, com o cooldown ativo
  await emVoo;

  assert.ok(
    api.rateLimitRemainingMs() > 0,
    'a resposta OK concorrente não pode zerar o cooldown'
  );

  // E o bloqueio segue valendo para novas chamadas.
  await assert.rejects(() => api.getPlaybackState(), { name: 'RateLimitError' });
});

test('cooldown expirado libera as requisições novamente', async () => {
  clearBlockFile();
  // Cooldown que já passou: o plugin deve voltar a operar normalmente.
  writeBlockFile(Date.now() - 1000);

  const { api, calls } = await loadApi(() => playerOk());

  assert.equal(api.rateLimitRemainingMs(), 0, 'cooldown vencido não deve bloquear');
  const state = await api.getPlaybackState();
  assert.equal(calls.length, 1, 'a requisição deve ser enviada');
  assert.equal(state.trackId, 'track1');
});

test('cooldown sobrevive ao reinício do processo (persistido em disco)', async () => {
  clearBlockFile();
  const { api } = await loadApi(() => tooManyRequests(600));
  await assert.rejects(() => api.getPlaybackState(), { name: 'RateLimitError' });

  // Simula o processo reiniciando: nova instância do módulo lê o arquivo.
  const { api: apiReiniciado, calls } = await loadApi(() => playerOk());
  assert.ok(
    apiReiniciado.rateLimitRemainingMs() > 0,
    'após reiniciar, o bloqueio anterior deve ser respeitado'
  );
  await assert.rejects(() => apiReiniciado.getPlaybackState(), { name: 'RateLimitError' });
  assert.equal(calls.length, 0, 'nenhuma requisição após reiniciar durante o cooldown');
});

test('rajada de comandos durante o cooldown não gera nenhuma requisição', async () => {
  // Cenário real: várias teclas (play/pause, shuffle, repeat, volume, mudo) sendo
  // apertadas enquanto o Spotify está limitando — nada pode ir para a rede.
  clearBlockFile();
  const { api, calls } = await loadApi(() => tooManyRequests(60));

  await assert.rejects(() => api.getPlaybackState(), { name: 'RateLimitError' });
  assert.equal(calls.length, 1);

  const comandos = [
    () => api.play(),
    () => api.pause(),
    () => api.next(),
    () => api.setVolume(30),
    () => api.setShuffle(true),
    () => api.setRepeat('context'),
    () => api.getPlaybackState(),
  ];
  for (const cmd of comandos) {
    await assert.rejects(cmd, { name: 'RateLimitError' });
  }
  assert.equal(calls.length, 1, 'a rajada inteira deve falhar localmente, sem rede');
});

test('Retry-After ausente usa um fallback conservador', async () => {
  clearBlockFile();
  const semHeader = () =>
    new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });
  const { api } = await loadApi(semHeader);

  await assert.rejects(() => api.getPlaybackState(), { name: 'RateLimitError' });
  const remaining = api.rateLimitRemainingMs();
  assert.ok(remaining > 0, 'sem Retry-After ainda deve bloquear');
  assert.ok(remaining <= 5000, `fallback deve ser curto, veio ${remaining}`);
});

test('operação normal (sem 429) não cria bloqueio', async () => {
  clearBlockFile();
  const { api, calls } = await loadApi(() => playerOk());

  await api.getPlaybackState();
  await api.getPlaybackState();
  assert.equal(calls.length, 2, 'sem cooldown, cada chamada vai à rede');
  assert.equal(api.rateLimitRemainingMs(), 0, 'não deve haver bloqueio');
});

test.after(() => {
  // Não deixa um cooldown de teste atrapalhar o plugin em execução.
  clearBlockFile();
});
