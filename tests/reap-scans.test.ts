import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { reapStrandedScans } from '../worker/reap-scans.js';

/**
 * Récupération des scans abandonnés par un job mort.
 *
 * Un job mort est visible — le tableau de santé alarme dès le premier. Mais le
 * SCAN restait dans son état de traitement pour toujours, et la clôture d'un lot
 * refuse tant qu'une carte est en traitement : un seul job mort rendait la
 * réconciliation d'un lot entier impossible. Sur le contrôle qui est justement
 * le seul à rattraper une carte physique sans ligne d'inventaire.
 */
const SESSION = 'test-reap';
let sessionId: string;
let seq = 0;

async function wipe(): Promise<void> {
  await query(
    `delete from jobs where payload->>'scan_id' in (
       select s.id::text from scans s join sessions ss on ss.id = s.session_id
        where ss.name = $1)`,
    [SESSION],
  );
  await query(
    `delete from scans where session_id in (select id from sessions where name = $1)`,
    [SESSION],
  );
  await query('delete from sessions where name = $1', [SESSION]);
}

async function scanAvecJobMort(
  status: string,
  jobType: 'fingerprint' | 'match',
  jobStatus = 'dead',
): Promise<string> {
  seq += 1;
  const { rows } = await query<{ id: string }>(
    `insert into scans (session_id, seq, front_path, status)
     values ($1, $2, '/x.jpg', $3::scan_status) returning id`,
    [sessionId, seq, status],
  );
  const id = rows[0]!.id;
  await query(
    `insert into jobs (type, payload, idempotency_key, status, last_error)
     values ($1, $2, $3, $4, 'boum')`,
    [jobType, { scan_id: id }, `${jobType}:${id}`, jobStatus],
  );
  return id;
}

async function statut(id: string): Promise<{ status: string; error: string | null }> {
  const { rows } = await query<{ status: string; error: string | null }>(
    'select status::text, error from scans where id = $1',
    [id],
  );
  return rows[0]!;
}

beforeEach(async () => {
  await wipe();
  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition)
     values ($1,'normal','NM') returning id`,
    [SESSION],
  );
  sessionId = rows[0]!.id;
  seq = 0;
});

afterAll(async () => {
  await wipe();
  await closePool();
});

describe('reapStrandedScans', () => {
  it('ÉCARTE un scan dont l’empreinte a échoué — la review n’en ferait rien', async () => {
    // Sans empreinte, `confirmScan` refuse : un scan `pending` envoyé en review
    // serait une impasse. La carte est à repasser au scanner, et la ligne le dit.
    const id = await scanAvecJobMort('pending', 'fingerprint');
    const r = await reapStrandedScans();

    expect(r.ecartes).toBe(1);
    const s = await statut(id);
    expect(s.status).toBe('rejected');
    expect(s.error).toMatch(/repasser au scanner/);
  });

  it('ENVOIE EN REVIEW un scan dont le matching a échoué', async () => {
    // Il porte son image et ses empreintes : c'est exactement ce que le
    // niveau 3 est censé recevoir.
    const id = await scanAvecJobMort('fingerprinted', 'match');
    const r = await reapStrandedScans();

    expect(r.envoyesEnReview).toBe(1);
    const s = await statut(id);
    expect(s.status).toBe('needs_review');
    expect(s.error).toMatch(/matching automatique abandonné/);
  });

  it('LE LOT REDEVIENT CLOSABLE — c’est le point', async () => {
    await scanAvecJobMort('pending', 'fingerprint');
    await scanAvecJobMort('fingerprinted', 'match');
    await reapStrandedScans();

    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from scans
        where session_id = $1 and status in ('pending','fingerprinted','matched')`,
      [sessionId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('ne touche pas un scan dont le job vit encore', async () => {
    const id = await scanAvecJobMort('pending', 'fingerprint', 'queued');
    const r = await reapStrandedScans();
    expect(r.ecartes).toBe(0);
    expect((await statut(id)).status).toBe('pending');
  });

  it('ne touche pas un scan déjà résolu', async () => {
    const id = await scanAvecJobMort('resolved', 'match');
    await reapStrandedScans();
    expect((await statut(id)).status).toBe('resolved');
  });

  it('est rejouable sans rien casser', async () => {
    await scanAvecJobMort('fingerprinted', 'match');
    const premier = await reapStrandedScans();
    const second = await reapStrandedScans();
    expect(premier.envoyesEnReview).toBe(1);
    expect(second.envoyesEnReview).toBe(0);
  });

  it('ne fait rien quand rien n’est bloqué', async () => {
    expect(await reapStrandedScans()).toEqual({ ecartes: 0, envoyesEnReview: 0 });
  });
});
