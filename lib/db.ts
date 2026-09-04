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

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: loadEnv().DATABASE_URL,
    max: 10,
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
