import pg from 'pg';
import { loadEnv } from './env.js';

/**
 * Pool Postgres partagé. Un seul pool par process — le worker et Next en ont
 * chacun le leur.
 */
const { Pool } = pg;

// numeric (OID 1700) revient en string par défaut dans node-postgres. C'est le bon
// comportement et on le garde : CLAUDE.md interdit le float dans un calcul d'argent
// cumulatif. Le parsing en cents se fait explicitement là où c'est nécessaire.

let pool: pg.Pool | null = null;

/**
 * Taille du pool, par process.
 *
 * MESURÉ, pas choisi : le pooler Supabase en mode session est limité à
 * **15 clients**. Deux process (le worker et Next) à 10 connexions chacun font
 * 20, et le vingt-et-unième reçoit `EMAXCONNSESSION: max clients reached`. Sous
 * charge, l'application et le worker s'affament mutuellement.
 *
 * 5 par process laisse 5 connexions libres pour psql, les scripts et un second
 * onglet. Augmenter cette valeur sans augmenter la limite du pooler ne rend rien
 * plus rapide : ça déplace juste l'attente du pool applicatif vers un refus du
 * serveur.
 */
const POOL_MAX = Number(process.env['PG_POOL_MAX'] ?? 5);

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: loadEnv().DATABASE_URL,
    max: Number.isFinite(POOL_MAX) && POOL_MAX > 0 ? POOL_MAX : 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/**
 * Exécute une fonction dans une transaction. Invariant 2 de CLAUDE.md : aucune
 * écriture d'inventaire hors transaction.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
