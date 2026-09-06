import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { claim, complete, enqueue, fail, reclaimStale, type Job, pruneJobs } from '../worker/queue/queue.js';
import { PermanentError, classifyError } from '../worker/queue/errors.js';

const TYPE = 'test_job';

async function wipe(): Promise<void> {
  await query('delete from jobs where type = $1', [TYPE]);
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closePool();
});

describe('file de jobs', () => {
  it('quatre workers en parallèle ne prennent jamais le même job', async () => {
    const N = 100;
    for (let i = 0; i < N; i++) {
      await enqueue(TYPE, { i }, { idempotencyKey: `${TYPE}:${i}` });
    }

    // Chaque worker vide la file aussi vite qu'il peut. Si SKIP LOCKED faisait
    // son travail à moitié, deux workers ramèneraient le même id.
    const drain = async (workerId: string): Promise<number[]> => {
      const got: number[] = [];
      for (;;) {
        const job = await claim(TYPE, workerId);
        if (!job) break;
        got.push(job.id);
        await complete(job);
      }
      return got;
    };

    const results = await Promise.all(
      ['w1', 'w2', 'w3', 'w4'].map((w) => drain(w)),
    );

    const all = results.flat();
    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N); // aucun doublon entre workers

    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from jobs where type=$1 and status='done'`,
      [TYPE],
    );
    expect(Number(rows[0]?.n)).toBe(N);
  }, 60_000);

  it('un crash à mi-parcours ne perd aucun job : le bail expiré est repris', async () => {
    await enqueue(TYPE, { k: 'crash' }, { idempotencyKey: `${TYPE}:crash` });

    const job = await claim(TYPE, 'worker-qui-va-mourir');
    expect(job).not.toBeNull();

    // Le worker meurt ici. La ligne reste en 'running' — et la requête de
    // réclamation ne regarde QUE 'queued' et 'failed'. Sans reaper, ce job est
    // perdu pour toujours.
    expect(await claim(TYPE, 'worker-survivant')).toBeNull();

    await query(
      `update jobs set locked_at = now() - interval '1 hour' where id = $1`,
      [job?.id],
    );

    expect(await reclaimStale()).toBeGreaterThanOrEqual(1);

    const reclaimed = await claim(TYPE, 'worker-survivant');
    expect(reclaimed?.id).toBe(job?.id);
    expect(reclaimed?.attempts).toBe(2); // la reprise compte comme une tentative
  });

  it('une clé d’idempotence identique n’enfile qu’une fois', async () => {
    const first = await enqueue(TYPE, { a: 1 }, { idempotencyKey: `${TYPE}:dup` });
    const second = await enqueue(TYPE, { a: 1 }, { idempotencyKey: `${TYPE}:dup` });

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // conflit = succès silencieux

    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from jobs where type=$1',
      [TYPE],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('une erreur permanente tue le job immédiatement, sans brûler cinq tentatives', async () => {
    await enqueue(TYPE, {}, { idempotencyKey: `${TYPE}:perm` });
    const job = (await claim(TYPE, 'w')) as Job;

    await fail(job, new PermanentError('SKU inexistant'));

    const { rows } = await query<{ status: string; attempts: number }>(
      'select status, attempts from jobs where id = $1',
      [job.id],
    );
    expect(rows[0]?.status).toBe('dead');
    expect(rows[0]?.attempts).toBe(1);
  });

  it('une erreur transitoire replanifie avec un backoff exponentiel', async () => {
    await enqueue(TYPE, {}, { idempotencyKey: `${TYPE}:trans` });
    const job = (await claim(TYPE, 'w')) as Job;

    await fail(job, Object.assign(new Error('rate limited'), { status: 429 }));

    const { rows } = await query<{ status: string; delta: string }>(
      `select status, extract(epoch from (run_after - now()))::text as delta
         from jobs where id = $1`,
      [job.id],
    );
    expect(rows[0]?.status).toBe('failed');
    // attempts vaut 1 après la réclamation → 2^1 * 10s = 20s
    expect(Number(rows[0]?.delta)).toBeGreaterThan(10);
    expect(Number(rows[0]?.delta)).toBeLessThanOrEqual(20);
  });
});

describe('classification des erreurs', () => {
  it('sépare transitoire, permanent et ambigu', () => {
    expect(classifyError(Object.assign(new Error(), { status: 503 })).class).toBe('transient');
    expect(classifyError(Object.assign(new Error(), { code: 'ETIMEDOUT' })).class).toBe('transient');
    expect(classifyError(Object.assign(new Error(), { status: 400 })).class).toBe('permanent');
    expect(classifyError(new PermanentError('nope')).class).toBe('permanent');
    expect(classifyError(new Error('boum')).class).toBe('ambiguous');
    expect(classifyError(Object.assign(new Error(), { status: 500 })).class).toBe('ambiguous');
  });
});

describe('pruneJobs', () => {
  /**
   * 258 octets par ligne, index compris. À 1 700 cartes par jour et deux jobs
   * par carte, ça fait 320 Mo par an — sur un quota de base de 500 Mo dont le
   * catalogue occupe déjà 121. La file finirait par coûter plus cher que les
   * empreintes qu'elle sert à produire, pour de l'historique que personne ne
   * relit.
   */
  const MARQUEUR = 'test-prune-jobs';

  async function poser(status: string, ageJours: number, i: number): Promise<void> {
    await query(
      `insert into jobs (type, payload, idempotency_key, status, completed_at, created_at)
       values ('fingerprint', '{}'::jsonb, $1, $2,
               now() - ($3::int * interval '1 day'),
               now() - ($3::int * interval '1 day'))`,
      [`${MARQUEUR}:${status}:${i}`, status, ageJours],
    );
  }

  async function reste(status: string): Promise<number> {
    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from jobs
        where idempotency_key like $1 and status = $2`,
      [`${MARQUEUR}:%`, status],
    );
    return Number(rows[0]?.n);
  }

  /**
   * Les LIGNES qui existent encore, quel que soit leur statut.
   *
   * Une purge se juge sur ce qu'elle supprime, pas sur des statuts : si un
   * worker tourne pendant les tests — le lanceur en garde un en permanence — il
   * réclame légitimement un job `queued` et le passe à `running` puis à `dead`.
   * La version précédente comptait par statut et échouait alors sur une
   * machine où l'application tournait, ce qui est le cas normal.
   */
  async function lignes(): Promise<number> {
    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from jobs where idempotency_key like $1`,
      [`${MARQUEUR}:%`],
    );
    return Number(rows[0]?.n);
  }

  beforeEach(async () => {
    await query(`delete from jobs where idempotency_key like $1`, [`${MARQUEUR}:%`]);
  });

  it('efface les terminés anciens, garde les récents', async () => {
    await poser('done', 30, 1);
    await poser('done', 2, 2);

    await pruneJobs(14);
    expect(await reste('done')).toBe(1);
  });

  it('GARDE LES MORTS — c’est la trace de ce qui a raté', async () => {
    // Le tableau de santé les compte, et un job mort est la seule trace d'un
    // scan que le pipeline n'a pas su traiter.
    await poser('dead', 90, 3);
    await pruneJobs(14);
    expect(await reste('dead')).toBe(1);
  });

  it('ne touche ni la file ni ce qui tourne', async () => {
    await poser('queued', 90, 4);
    await poser('running', 90, 5);
    await poser('failed', 90, 6);

    await pruneJobs(14);
    // Trois lignes posées, trois lignes restantes. On ne vérifie pas les
    // statuts : un worker en marche a le droit de faire avancer un job pendant
    // le test, et ce n'est pas ce que la purge promet.
    expect(await lignes()).toBe(3);
  });

  it('respecte le délai qu’on lui donne', async () => {
    // On compte NOS lignes, pas le retour de la fonction : la purge est globale
    // par nature, et d'autres jobs terminés peuvent traîner dans la base.
    await poser('done', 10, 7);
    await pruneJobs(30);
    expect(await reste('done')).toBe(1);
    await pruneJobs(5);
    expect(await reste('done')).toBe(0);
  });
});
