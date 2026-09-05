import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, query } from '../lib/db.js';
import { handleFingerprint } from '../worker/handlers/fingerprint.js';
import type { Job } from '../worker/queue/queue.js';

/**
 * Une image PRÉSENTE mais indécodable.
 *
 * Le fichier est là, il ne se décode pas : tronqué, ou pas une image. Retenter
 * ne le réparera pas. Laisser le job mourir laissait le scan en `pending` POUR
 * TOUJOURS — et donc le lot impossible à clore, puisque la clôture refuse tant
 * qu'une carte est en traitement. Un seul fichier corrompu bloquait la
 * réconciliation d'un lot entier.
 *
 * Distinct du fichier ABSENT, qui reste une erreur ambiguë : le watcher commit
 * la ligne puis déplace le fichier, et il existe une fenêtre où le chemin final
 * n'est pas encore en place.
 */
const SESSION = 'test-fp-illisible';
let dir: string;
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

async function scanSur(chemin: string): Promise<string> {
  seq += 1;
  const { rows } = await query<{ id: string }>(
    `insert into scans (session_id, seq, front_path, status)
     values ($1, $2, $3, 'pending') returning id`,
    [sessionId, seq, chemin],
  );
  return rows[0]!.id;
}

const job = (scanId: string): Job =>
  ({ id: '1', type: 'fingerprint', payload: { scan_id: scanId }, attempts: 1 }) as unknown as Job;

beforeEach(async () => {
  await wipe();
  dir = await mkdtemp(join(tmpdir(), 'pokelister-fp-'));
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
  await rm(dir, { recursive: true, force: true });
});

async function etat(id: string): Promise<{ status: string; error: string | null }> {
  const { rows } = await query<{ status: string; error: string | null }>(
    'select status::text, error from scans where id = $1',
    [id],
  );
  return rows[0]!;
}

describe('handleFingerprint sur une image indécodable', () => {
  it('ÉCARTE le scan au lieu de le laisser en pending pour toujours', async () => {
    const chemin = join(dir, 'corrompu.jpg');
    await writeFile(chemin, 'ceci n’est pas une image');
    const id = await scanSur(chemin);

    // Ne lève pas : le job se termine, la trace est dans la ligne.
    await handleFingerprint(job(id));

    const e = await etat(id);
    expect(e.status).toBe('rejected');
    expect(e.error).toMatch(/illisible/);
  });

  it('n’enfile PAS de match pour un scan écarté', async () => {
    const chemin = join(dir, 'corrompu2.jpg');
    await writeFile(chemin, 'x');
    const id = await scanSur(chemin);
    await handleFingerprint(job(id));

    const { rows } = await query(
      `select 1 from jobs where type = 'match' and payload->>'scan_id' = $1`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });

  it('LE LOT REDEVIENT CLOSABLE — c’est le point', async () => {
    // La clôture refuse tant qu'un scan est dans un état de traitement.
    const chemin = join(dir, 'corrompu3.jpg');
    await writeFile(chemin, 'x');
    const id = await scanSur(chemin);
    await handleFingerprint(job(id));

    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from scans
        where session_id = $1 and status in ('pending','fingerprinted','matched')`,
      [sessionId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('un fichier ABSENT reste une erreur, pas un rejet', async () => {
    // Le watcher commit la ligne puis déplace le fichier : il existe une
    // fenêtre où le chemin final n'est pas encore en place, et deux tentatives
    // avec backoff la couvrent. L'écarter tout de suite perdrait la carte.
    const id = await scanSur(join(dir, 'jamais-ecrit.jpg'));
    await expect(handleFingerprint(job(id))).rejects.toThrow(/illisible pour le scan/);
    expect((await etat(id)).status).toBe('pending');
  });
});
