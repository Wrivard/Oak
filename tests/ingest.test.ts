import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { ingestFile, type WatcherOptions } from '../worker/ingest/watcher.js';
import { parseName } from '../worker/ingest/filename.js';

const SESSION = 'test-ingest-session';
let sessionId: string;
let dirs: WatcherOptions;
let root: string;

/** Une vraie image JPEG : le watcher ne la lit pas, mais le handler si. */
async function writeCard(dir: string, name: string, tint: number): Promise<string> {
  const path = join(dir, name);
  const buf = await sharp({
    create: { width: 60, height: 84, channels: 3, background: { r: tint, g: 40, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await writeFile(path, buf);
  return path;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pokelister-ingest-'));
  dirs = {
    inbox: join(root, 'inbox'),
    processed: join(root, 'processed'),
    rejected: join(root, 'rejected'),
  };
  const { mkdir } = await import('node:fs/promises');
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition)
     values ($1, 'normal', 'NM') returning id`,
    [SESSION],
  );
  sessionId = rows[0]!.id;
});

afterAll(async () => {
  await query('delete from jobs where payload->>$1 in (select id::text from scans where session_id = $2)', ['scan_id', sessionId]);
  await query('delete from scans where session_id = $1', [sessionId]);
  await query('delete from sessions where id = $1', [sessionId]);
  await closePool();
  await rm(root, { recursive: true, force: true });
});

describe('parseName', () => {
  it('découpe {session}_{seq}_{side}', () => {
    expect(parseName('lot-42_000007_front.jpg')).toEqual({
      session: 'lot-42',
      seq: 7,
      side: 'front',
    });
  });

  it('accepte un nom de session contenant des underscores', () => {
    expect(parseName('bulk_mars_2026_000012_back.jpg')).toEqual({
      session: 'bulk_mars_2026',
      seq: 12,
      side: 'back',
    });
  });

  it('rejette ce qui ne correspond pas', () => {
    expect(parseName('nimportequoi.jpg')).toBeNull();
    expect(parseName('lot_000001_middle.jpg')).toBeNull();
    expect(parseName('lot_abc_front.jpg')).toBeNull();
    expect(parseName('lot_000001_front.txt')).toBeNull();
  });
});

describe('ingestion', () => {
  it('un recto crée une ligne scans, enfile un fingerprint et déplace le fichier', async () => {
    const f = await writeCard(dirs.inbox, `${SESSION}_000001_front.jpg`, 200);
    await ingestFile(f, dirs);

    const { rows } = await query<{ id: string; status: string; front_path: string }>(
      'select id, status, front_path from scans where session_id=$1 and seq=1',
      [sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');

    const { rows: jobs } = await query<{ idempotency_key: string }>(
      'select idempotency_key from jobs where idempotency_key = $1',
      [`fingerprint:${rows[0]?.id}`],
    );
    expect(jobs).toHaveLength(1);

    expect(await readdir(join(dirs.processed, SESSION))).toContain(
      `${SESSION}_000001_front.jpg`,
    );
    expect(await readdir(dirs.inbox)).toHaveLength(0);
  });

  it('le chemin enregistré reste lisible APRÈS le déplacement du fichier', async () => {
    // Le bug que les autres tests ne voyaient pas : ils vérifiaient qu'une ligne
    // était créée ET que le fichier était déplacé, sans jamais vérifier que le
    // chemin en base survivait au déplacement. Il pointait sur l'inbox, vidé
    // juste après — et tous les jobs fingerprint mouraient sur "image illisible".
    const f = await writeCard(dirs.inbox, `${SESSION}_000009_front.jpg`, 77);
    await ingestFile(f, dirs);

    const { rows } = await query<{ front_path: string }>(
      'select front_path from scans where session_id=$1 and seq=9',
      [sessionId],
    );
    const recorded = rows[0]!.front_path;

    const { readFile } = await import('node:fs/promises');
    await expect(readFile(recorded)).resolves.toBeInstanceOf(Buffer);
    expect(recorded).toContain('processed');
  });

  it('un fichier revu deux fois ne crée qu’une ligne', async () => {
    // C'est le cas du redémarrage : ignoreInitial:false rejoue tout l'inbox.
    const a = await writeCard(dirs.inbox, `${SESSION}_000002_front.jpg`, 100);
    await ingestFile(a, dirs);
    const b = await writeCard(dirs.inbox, `${SESSION}_000002_front.jpg`, 100);
    await ingestFile(b, dirs);

    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from scans where session_id=$1 and seq=2',
      [sessionId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('le compteur de session ne compte pas deux fois le même seq', async () => {
    // scanned_count est ce qu'on réconcilie contre le compteur du scanner pour
    // attraper les double-feed. Le sur-compter masquerait un écart réel.
    const { rows } = await query<{ scanned_count: number }>(
      'select scanned_count from sessions where id=$1',
      [sessionId],
    );
    const { rows: distinct } = await query<{ n: string }>(
      'select count(*)::text as n from scans where session_id=$1',
      [sessionId],
    );
    expect(rows[0]?.scanned_count).toBe(Number(distinct[0]?.n));
  });

  it('un verso arrivé après son recto se rattache', async () => {
    const f = await writeCard(dirs.inbox, `${SESSION}_000003_front.jpg`, 150);
    await ingestFile(f, dirs);
    const b = await writeCard(dirs.inbox, `${SESSION}_000003_back.jpg`, 30);
    await ingestFile(b, dirs);

    const { rows } = await query<{ back_path: string | null }>(
      'select back_path from scans where session_id=$1 and seq=3',
      [sessionId],
    );
    expect(rows[0]?.back_path).not.toBeNull();
  });

  it('un verso arrivé AVANT son recto est rattaché quand le recto arrive', async () => {
    const b = await writeCard(dirs.inbox, `${SESSION}_000004_back.jpg`, 30);
    await ingestFile(b, dirs);

    // Aucune ligne encore : front_path est NOT NULL, on ne peut pas créer depuis
    // un verso. Le fichier reste de côté.
    const { rows: before } = await query(
      'select 1 from scans where session_id=$1 and seq=4',
      [sessionId],
    );
    expect(before).toHaveLength(0);

    const f = await writeCard(dirs.inbox, `${SESSION}_000004_front.jpg`, 150);
    await ingestFile(f, dirs);

    const { rows } = await query<{ back_path: string | null }>(
      'select back_path from scans where session_id=$1 and seq=4',
      [sessionId],
    );
    expect(rows[0]?.back_path).not.toBeNull();
  });

  it('une session inconnue est rejetée, jamais créée à la volée', async () => {
    // Créer la session voudrait dire deviner default_variant, qui encode la
    // décision de pré-tri du foil. Mal la deviner mal-étiquette un lot entier.
    const f = await writeCard(dirs.inbox, `session-qui-nexiste-pas_000001_front.jpg`, 10);
    await ingestFile(f, dirs);

    expect(await readdir(join(dirs.rejected, 'session-qui-nexiste-pas'))).toHaveLength(1);
    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from sessions where name=$1',
      ['session-qui-nexiste-pas'],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('un nom non conforme part en rejet, il n’est jamais supprimé', async () => {
    const f = await writeCard(dirs.inbox, 'scan-sans-convention.jpg', 10);
    await ingestFile(f, dirs);
    expect(await readdir(join(dirs.rejected, '_unparsed'))).toContain(
      'scan-sans-convention.jpg',
    );
  });
});
