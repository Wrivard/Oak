import { loadEnv } from './env.js';

/**
 * Logger JSON structuré. Champs de docs/05-production.md §1.1.
 *
 * Règle de CLAUDE.md : jamais de `catch {}` vide. Toute erreur avalée passe ici
 * avec au minimum un scan_id ou un sku.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  scan_id?: string;
  sku?: string;
  job_id?: number;
  job_type?: string;
  session_id?: string;
  channel?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

/**
 * Masque tout ce qui ressemble à un secret. Exigé par docs/05 §4 : un token eBay
 * ne doit jamais apparaître dans un log ni dans un message d'erreur.
 */
const SECRET_KEY = /(token|secret|password|key|authorization|cookie|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[profond]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function emit(level: LogLevel, msg: string, ctx: LogContext = {}): void {
  const min = ORDER[loadEnv().LOG_LEVEL];
  if (ORDER[level] < min) return;

  const { err, ...rest } = ctx;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(redact(rest) as Record<string, unknown>),
    ...(err === undefined ? {} : { err: serializeError(err) }),
  };

  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
};
