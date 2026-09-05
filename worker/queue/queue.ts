import type { PoolClient } from 'pg';
import { query } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import { classifyError } from './errors.js';

/**
 * File de jobs en Postgres. Voir docs/01 §migration 005 et le skill queue-handler.
 */
export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
}

/**
 * Durée du bail sur un job réclamé. Au-delà, `reclaimStale` considère que le
 * worker qui le tenait est mort et remet le job en file.
 */
export const LEASE_MS = 10 * 60 * 1000;

/**
 * Réclamation atomique. C'EST le seul pattern autorisé — jamais un SELECT suivi
 * d'un UPDATE séparé, ça double les jobs dès que deux workers tournent.
 */
export async function claim(type: string, workerId: string): Promise<Job | null> {
  const { rows } = await query<Job>(
    `update jobs
        set status = 'running', locked_at = now(), locked_by = $2,
            attempts = attempts + 1
      where id = (
        select id from jobs
         where type = $1
           and status in ('queued','failed')
           and run_after <= now()
         order by priority, id
         for update skip locked
         limit 1
      )
    returning *`,
    [type, workerId],
  );
  return rows[0] ?? null;
}

/**
 * Remet en file les jobs dont le bail a expiré.
 *
 * Sans ça, un worker tué en plein job laisse la ligne en `running` pour
 * toujours : la requête de réclamation ne regarde que `queued` et `failed`, et
 * personne ne lit `locked_at`. Le job — donc le scan — est perdu en silence.
 * C'est le trou que le test "un crash à mi-parcours ne perd aucun scan" révèle.
 */
export async function reclaimStale(leaseMs = LEASE_MS): Promise<number> {
  const { rowCount } = await query(
    `update jobs
        set status = 'queued', locked_by = null, locked_at = null,
            last_error = coalesce(last_error, 'bail expiré, worker présumé mort')
      where status = 'running'
        and locked_at < now() - ($1::bigint * interval '1 millisecond')`,
    [leaseMs],
  );
  if (rowCount && rowCount > 0) {
    log.warn('jobs repris après expiration de bail', { count: rowCount });
  }
  return rowCount ?? 0;
}

/**
 * Repousse un job SANS consommer de tentative.
 *
 * Sert au circuit breaker : une panne du service externe n'est pas la faute du
 * job. Lui faire brûler ses `max_attempts` transformerait une panne de vingt
 * minutes en montagne de jobs `dead` à rejouer à la main (docs/05 §2.4).
 */
export async function defer(job: Job, retryAt: number, reason: string): Promise<void> {
  await query(
    `update jobs
        set status = 'queued', locked_by = null, locked_at = null,
            attempts = greatest(attempts - 1, 0),
            last_error = $2,
            run_after = to_timestamp($3 / 1000.0)
      where id = $1`,
    [job.id, reason, retryAt],
  );
  log.warn('job repoussé sans consommer de tentative', {
    job_id: job.id,
    job_type: job.type,
    reprise: new Date(retryAt).toISOString(),
    raison: reason,
  });
}

export async function complete(job: Job): Promise<void> {
  await query(
    `update jobs set status='done', completed_at=now(), locked_by=null, locked_at=null
      where id=$1`,
    [job.id],
  );
}

/**
 * Échec d'un job. Backoff exponentiel `2^attempts * 10s`, et `dead` dès que le
 * nombre de tentatives dépasse ce que la classe d'erreur autorise.
 */
export async function fail(job: Job, err: unknown): Promise<void> {
  const classified = classifyError(err);
  const budget = Math.min(job.max_attempts, classified.maxAttempts);
  const dead = job.attempts >= budget;

  if (dead) {
    await query(
      `update jobs set status='dead', last_error=$2, locked_by=null, locked_at=null
        where id=$1`,
      [job.id, classified.message],
    );
    log.error('job mort', {
      job_id: job.id,
      job_type: job.type,
      attempts: job.attempts,
      error_class: classified.class,
      err,
    });
    return;
  }

  const delayMs = 2 ** job.attempts * 10_000;
  await query(
    `update jobs
        set status='failed', last_error=$2, locked_by=null, locked_at=null,
            run_after = now() + ($3::bigint * interval '1 millisecond')
      where id=$1`,
    [job.id, classified.message, delayMs],
  );
  log.warn('job en échec, replanifié', {
    job_id: job.id,
    job_type: job.type,
    attempts: job.attempts,
    error_class: classified.class,
    retry_dans_ms: delayMs,
  });
}

/**
 * Met un job en file. `idempotencyKey` doit être DÉTERMINISTE : c'est ce qui rend
 * le rejeu sûr. Un conflit sur la clé est un succès silencieux, pas une erreur.
 */
export async function enqueue(
  type: string,
  payload: Record<string, unknown>,
  opts: { idempotencyKey?: string; priority?: number; client?: PoolClient } = {},
): Promise<number | null> {
  const exec = opts.client
    ? (t: string, p: unknown[]) => opts.client!.query(t, p)
    : (t: string, p: unknown[]) => query(t, p);

  const { rows } = await exec(
    `insert into jobs (type, payload, idempotency_key, priority)
     values ($1, $2, $3, coalesce($4, 100))
     on conflict (idempotency_key) do nothing
     returning id`,
    [type, payload, opts.idempotencyKey ?? null, opts.priority ?? null],
  );
  return (rows[0] as { id: number } | undefined)?.id ?? null;
}

/**
 * Purge les jobs TERMINÉS.
 *
 * Mesuré le 5 septembre 2026 : **258 octets par ligne**, index compris. À
 * 1 700 cartes par jour, chacune produisant un `fingerprint` et un `match`, ça
 * fait 878 ko par jour et **320 Mo par an** — sur un quota de base de 500 Mo
 * dont `cards` et `card_embeddings` occupent déjà 121. La file finirait par
 * coûter plus cher que les empreintes qu'elle sert à produire, pour de
 * l'historique que personne ne relit.
 *
 * Seuls les `done` partent. Les `dead` RESTENT : ce sont eux la trace de ce qui
 * a échoué, et le tableau de santé les compte.
 *
 * Effacer une clé d'idempotence n'est pas un risque ici : à quatorze jours, un
 * rejeu de `fingerprint` ou de `match` trouve un scan déjà traité et sort en
 * silence, et un `pair_upload` rejoué ignore les fichiers déjà rattachés.
 */
export async function pruneJobs(days = 14): Promise<number> {
  const { rowCount } = await query(
    `delete from jobs
      where status = 'done'
        and coalesce(completed_at, created_at) < now() - ($1::int * interval '1 day')`,
    [days],
  );
  if (rowCount && rowCount > 0) {
    log.info('jobs terminés purgés', { supprimes: rowCount, plus_vieux_que_jours: days });
  }
  return rowCount ?? 0;
}
