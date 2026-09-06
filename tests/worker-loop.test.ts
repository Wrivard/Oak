import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { enqueue } from '../worker/queue/queue.js';
import { Worker } from '../worker/queue/loop.js';

/**
 * La boucle du worker, en vrai.
 *
 * Les tests de file couvraient `claim`, `complete` et `fail` un par un, mais
 * personne ne faisait tourner la BOUCLE : réclamer, exécuter, terminer, puis
 * recommencer. C'est pourtant le seul endroit où le recul progressif des voies
 * inactives peut casser quelque chose — une voie qui s'endort et ne se réveille
 * plus arrêterait le pipeline entier sans une seule erreur dans les journaux.
 *
 * Le type est propre à ce fichier : le worker du lanceur ne le connaît pas et
 * ne viendra pas voler les jobs.
 */
const TYPE = 'test_loop';

async function wipe(): Promise<void> {
  await query('delete from jobs where type = $1', [TYPE]);
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closePool();
});

/** Laisse tourner la boucle jusqu'à ce que la condition tienne, ou abandonne. */
async function jusqua(
  condition: () => Promise<boolean>,
  limiteMs = 15_000,
): Promise<boolean> {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function statut(key: string): Promise<string | undefined> {
  const { rows } = await query<{ status: string }>(
    'select status from jobs where idempotency_key = $1',
    [key],
  );
  return rows[0]?.status;
}

describe('boucle du worker', () => {
  it('draine un job, puis en draine un SECOND après une pause', async () => {
    const vus: string[] = [];
    const worker = new Worker('test-loop', {
      [TYPE]: {
        handler: async (job) => {
          vus.push(String((job.payload as { n: unknown }).n));
        },
        concurrency: 1,
        // Plafond bas : le test doit pouvoir attendre le réveil sans durer
        // une minute, tout en passant par au moins un recul.
        idleMaxMs: 700,
      },
    });

    void worker.run();
    try {
      await enqueue(TYPE, { n: 1 }, { idempotencyKey: `${TYPE}:1` });
      expect(await jusqua(async () => (await statut(`${TYPE}:1`)) === 'done')).toBe(true);

      // LE POINT DU TEST. La voie a maintenant réclamé dans le vide plusieurs
      // fois et reculé jusqu'à son plafond. Un second job doit quand même être
      // pris : une voie endormie qui ne se réveille plus arrêterait le
      // pipeline sans un mot.
      await new Promise((r) => setTimeout(r, 2500));
      await enqueue(TYPE, { n: 2 }, { idempotencyKey: `${TYPE}:2` });
      expect(await jusqua(async () => (await statut(`${TYPE}:2`)) === 'done')).toBe(true);

      expect(vus).toEqual(['1', '2']);
    } finally {
      await worker.stop();
    }
  }, 30_000);
});
