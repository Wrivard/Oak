import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { nextSeq, openSession, registerScan } from '../lib/ingest/register.js';

/**
 * Chemin d'entrée par upload.
 *
 * Ce qui est vérifié ici est ce qui, en cas de bug, produit une CARTE PHYSIQUE
 * SANS LIGNE D'INVENTAIRE — le pire mode de défaillance du système, parce qu'il
 * est silencieux : on ne la vend pas, on ne la retrouve jamais.
 */
const SESSION = 'test-upload-session';
let dir: string;
let sessionId: string;

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

async function image(path: string, tint: number): Promise<void> {
  await writeFile(
    path,
    await sharp({
      create: { width: 60, height: 84, channels: 3, background: { r: tint, g: 40, b: 90 } },
    })
      .jpeg()
      .toBuffer(),
  );
}

beforeAll(async () => {
  await wipe();
  dir = await mkdtemp(join(tmpdir(), 'pokelister-upl-'));
  sessionId = await openSession({
    name: SESSION,
    variant: 'normal',
    condition: 'NM',
    language: 'en',
  });
});

afterAll(async () => {
  await wipe();
  await closePool();
  await rm(dir, { recursive: true, force: true });
});

describe('openSession', () => {
  it('réutilise la session ouverte du même nom au lieu d’en créer une seconde', async () => {
    // Deux sessions du même nom feraient deux lots là où l'utilisateur en voit
    // un, et le comptage de réconciliation ne balancerait jamais.
    const again = await openSession({
      name: SESSION,
      variant: 'holofoil',
      condition: 'LP',
      language: 'en',
    });
    expect(again).toBe(sessionId);
  });

  it('conserve le variant de la session existante', async () => {
    // Le variant d'un lot ne change pas en cours de route : les cartes déjà
    // enregistrées porteraient un variant, les suivantes un autre.
    const { rows } = await query<{ v: string }>(
      'select default_variant::text as v from sessions where id = $1',
      [sessionId],
    );
    expect(rows[0]?.v).toBe('normal');
  });
});

describe('registerScan', () => {
  it('crée le scan ET enfile son job dans la même transaction', async () => {
    // Un scan enregistré sans son job fingerprint n'est jamais traité, et rien
    // ne le signale.
    const path = join(dir, 'a.jpg');
    await image(path, 200);

    const { scanId, created } = await registerScan({
      sessionId,
      seq: 1,
      frontPath: path,
    });
    expect(created).toBe(true);

    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from jobs where idempotency_key = $1`,
      [`fingerprint:${scanId}`],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('incrémente le compteur de session à la création seulement', async () => {
    const before = await scannedCount();
    await registerScan({ sessionId, seq: 2, frontPath: join(dir, 'a.jpg') });
    expect(await scannedCount()).toBe(before + 1);

    // Rejeu du MÊME seq : le compteur ne doit pas bouger, sinon un rattrapage
    // masquerait l'écart de double-alimentation qu'on cherche à détecter.
    await registerScan({ sessionId, seq: 2, frontPath: join(dir, 'a.jpg') });
    expect(await scannedCount()).toBe(before + 1);
  });

  it('rejouer le même seq ne crée pas un second scan', async () => {
    const a = await registerScan({ sessionId, seq: 7, frontPath: join(dir, 'a.jpg') });
    const b = await registerScan({ sessionId, seq: 7, frontPath: join(dir, 'a.jpg') });
    expect(b.scanId).toBe(a.scanId);
    expect(b.created).toBe(false);
  });

  it('rattache le verso quand il est fourni', async () => {
    const back = join(dir, 'b.jpg');
    await image(back, 30);
    const { scanId } = await registerScan({
      sessionId,
      seq: 9,
      frontPath: join(dir, 'a.jpg'),
      backPath: back,
    });
    const { rows } = await query<{ back_path: string | null }>(
      'select back_path from scans where id = $1',
      [scanId],
    );
    expect(rows[0]?.back_path).toBe(back);
  });
});

describe('nextSeq', () => {
  it('prend la suite de ce qui existe', async () => {
    const { getPool } = await import('../lib/db.js');
    const client = await getPool().connect();
    try {
      const next = await nextSeq(sessionId, client);
      const { rows } = await query<{ max: string }>(
        'select coalesce(max(seq),0)::text as max from scans where session_id = $1',
        [sessionId],
      );
      expect(next).toBe(Number(rows[0]?.max) + 1);
    } finally {
      client.release();
    }
  });
});

describe('nommage des fichiers uploadés', () => {
  /**
   * Reproduit la règle de `nextRank` de la route d'upload.
   *
   * Le bug qu'elle corrige : renvoyer vers le même nom de lot recommençait à
   * zéro côté client et ÉCRASAIT les fichiers du premier envoi. Trois fichiers
   * là où il devait y en avoir six — des cartes scannées sans aucune trace.
   */
  function nextRank(existing: readonly string[]): number {
    let max = 0;
    for (const name of existing) {
      const n = Number(/^(\d{6})/.exec(name)?.[1] ?? 0);
      if (n > max) max = n;
    }
    return max;
  }

  it('repart de zéro sur un répertoire vide', () => {
    expect(nextRank([])).toBe(0);
  });

  it('prend la suite au lieu d’écraser', () => {
    expect(nextRank(['000001.jpg', '000002.jpg', '000003.jpg'])).toBe(3);
  });

  it('ignore les fichiers qui ne suivent pas la convention', () => {
    expect(nextRank(['000004.jpg', 'notes.txt', '.DS_Store'])).toBe(4);
  });

  it('résiste à un ordre alphabétique trompeur', () => {
    // readdir ne garantit pas l'ordre : c'est le MAXIMUM qui compte, pas le
    // dernier élément de la liste.
    expect(nextRank(['000010.jpg', '000002.jpg'])).toBe(10);
  });
});

async function scannedCount(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    'select scanned_count as n from sessions where id = $1',
    [sessionId],
  );
  return rows[0]?.n ?? -1;
}
