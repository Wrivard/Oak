import { z } from 'zod';

/**
 * Validation des variables d'environnement au démarrage.
 *
 * Échouer ici est volontaire : un worker qui démarre avec un DATABASE_URL vide
 * tourne en boucle d'erreurs pendant des heures avant qu'on s'en rende compte.
 * Mieux vaut ne pas démarrer du tout.
 */
/**
 * Une variable déclarée mais vide dans .env.local (`FOO=`) arrive comme chaîne
 * vide, pas comme undefined. Sans ça, tout champ optionnel non rempli fait
 * échouer le démarrage — ce qui est exactement l'inverse du but.
 */
function optional<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), inner.optional());
}

const schema = z.object({
  DATABASE_URL: z.string().url(),

  // Optionnels à l'étape 2 : rien ne parle encore à l'API Supabase.
  SUPABASE_URL: optional(z.string().url()),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(1)),

  WORKER_ID: z.string().min(1).default('worker-local-1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(racine)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Variables d'environnement invalides :\n${details}\n\n` +
        `Copie .env.example en .env.local et remplis les valeurs.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Réservé aux tests. */
export function resetEnvCache(): void {
  cached = null;
}
