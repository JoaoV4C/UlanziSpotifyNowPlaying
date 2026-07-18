// Registra erros não tratados e eventos notáveis (ex.: rate limit) do main
// service em plugin/error.log, para que falhas que de outra forma matariam o
// processo silenciosamente — ou bloqueios do Spotify — fiquem visíveis.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'error.log');

/** Anexa uma linha ao error.log com timestamp. */
export function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {
    /* ignore */
  }
}

function logError(kind, err) {
  logLine(`${kind} ${err?.stack || String(err)}`);
}

process.on('uncaughtException', (e) => logError('UNCAUGHT', e));
process.on('unhandledRejection', (e) => logError('UNHANDLED_REJECTION', e));
