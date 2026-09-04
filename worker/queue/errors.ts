/**
 * Classification d'erreur. Voir le skill queue-handler §3 et docs/05 §2.1.
 *
 * Retenter une erreur permanente cinq fois brûle du quota et retarde les vrais
 * jobs. Un job `dead` n'est jamais rejoué automatiquement.
 */
export type ErrorClass = 'transient' | 'permanent' | 'ambiguous';

export interface ClassifiedError {
  class: ErrorClass;
  message: string;
  /** Nombre de tentatives au-delà duquel le job passe `dead`. */
  maxAttempts: number;
}

const TRANSIENT_CODES = new Set([408, 425, 429, 502, 503, 504]);
const PERMANENT_CODES = new Set([400, 401, 403, 404, 409, 410, 422]);

/** Erreurs réseau Node : coupure, DNS, timeout. Toutes transitoires. */
const TRANSIENT_SYSCALLS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'EPIPE', 'ABORT_ERR',
]);

/** Marqueur explicite pour les erreurs qu'un handler sait définitives. */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code'] as const) {
    const v = rec[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const v = (err as Record<string, unknown>)['code'];
  return typeof v === 'string' ? v : undefined;
}

export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof PermanentError) {
    return { class: 'permanent', message, maxAttempts: 1 };
  }

  const code = codeOf(err);
  if (code !== undefined && TRANSIENT_SYSCALLS.has(code)) {
    return { class: 'transient', message, maxAttempts: 5 };
  }

  const status = statusOf(err);
  if (status !== undefined) {
    if (TRANSIENT_CODES.has(status)) {
      return { class: 'transient', message, maxAttempts: 5 };
    }
    if (PERMANENT_CODES.has(status)) {
      return { class: 'permanent', message, maxAttempts: 1 };
    }
  }

  // Tout le reste — 500, réponse malformée, bug de handler — est ambigu.
  // Deux tentatives, puis dead : on ne boucle pas sur un bug.
  return { class: 'ambiguous', message, maxAttempts: 2 };
}
