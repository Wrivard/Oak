import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import {
  nextSeq,
  openSession,
  registerScan,
  registerUnreadablePage,
} from '../lib/ingest/register.js';

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

describe('registerUnreadablePage', () => {
  /**
   * Une page dont le fichier ne se lit pas A EXISTÉ : elle est passée dans le
   * scanner. Elle était simplement `log.error`-ée puis oubliée — une carte
   * physique sans ligne d'inventaire, dont la seule trace était une ligne de
   * journal que personne ne lit. C'est le mode de défaillance que tout le
   * reste du système est conçu pour empêcher.
   */
  async function seqLibre(): Promise<number> {
    const { rows } = await query<{ next: string }>(
      'select coalesce(max(seq), 0) + 1 as next from scans where session_id = $1',
      [sessionId],
    );
    return Number(rows[0]?.next);
  }

  it('LAISSE UNE LIGNE VISIBLE au lieu de disparaître', async () => {
    const seq = await seqLibre();
    const res = await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: '/lot/000042.jpg',
      reason: 'image illisible : premature end of JPEG image',
    });
    expect(res.created).toBe(true);

    const { rows } = await query<{ status: string; error: string; path: string }>(
      'select status::text, error, front_path as path from scans where id = $1',
      [res.scanId],
    );
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.error).toMatch(/illisible/);
    expect(rows[0]?.path).toBe('/lot/000042.jpg');
  });

  it('N’ENFILE AUCUN JOB — il n’y a rien à traiter', async () => {
    // Un job voué à mourir polluerait le tableau de santé et ferait croire à
    // une panne du pipeline là où il n'y a qu'un fichier corrompu.
    const seq = await seqLibre();
    const res = await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: '/lot/000043.jpg',
      reason: 'illisible',
    });

    const { rows } = await query(
      `select 1 from jobs where payload->>'scan_id' = $1`,
      [res.scanId],
    );
    expect(rows).toHaveLength(0);
  });

  it('COMPTE dans la session — sinon l’écart de comptage se masque', async () => {
    const avant = await query<{ n: number }>(
      'select scanned_count as n from sessions where id = $1',
      [sessionId],
    );
    const seq = await seqLibre();
    await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: '/lot/000044.jpg',
      reason: 'illisible',
    });
    const apres = await query<{ n: number }>(
      'select scanned_count as n from sessions where id = $1',
      [sessionId],
    );
    expect(Number(apres.rows[0]?.n)).toBe(Number(avant.rows[0]?.n) + 1);
  });

  it('n’écrit ni inventaire ni empreinte', async () => {
    const seq = await seqLibre();
    const res = await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: '/lot/000045.jpg',
      reason: 'illisible',
    });
    const fp = await query('select 1 from known_fingerprints where source_scan = $1', [
      res.scanId,
    ]);
    expect(fp.rows).toHaveLength(0);
  });

  it('rejouer le même seq ne crée pas une seconde ligne', async () => {
    const seq = await seqLibre();
    const a = await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: '/lot/000046.jpg',
      reason: 'illisible',
    });
    const b = await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: '/lot/000046.jpg',
      reason: 'illisible',
    });
    expect(b.created).toBe(false);
    expect(b.scanId).toBe(a.scanId);
  });
});
