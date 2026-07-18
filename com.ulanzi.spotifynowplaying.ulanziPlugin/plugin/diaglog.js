// Registra erros não tratados do main service em plugin/error.log, para que
// falhas que de outra forma matariam o processo silenciosamente fiquem visíveis.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'error.log');

function logError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind} ${err?.stack || String(err)}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (e) => logError('UNCAUGHT', e));
process.on('unhandledRejection', (e) => logError('UNHANDLED_REJECTION', e));
