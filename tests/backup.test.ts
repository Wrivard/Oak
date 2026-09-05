import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { runBackup, runRestore, verifyBackup } from '../scripts/backup.js';

/**
 * « Teste ta restauration. Un backup jamais restauré n'est pas un backup. »
 * docs/05-production.md §5.
 *
 * Ce test fait l'ALLER-RETOUR COMPLET sur de vraies lignes : on écrit des
 * données, on sauvegarde, on EFFACE, on restaure, on compare. Un test qui se
 * contenterait de vérifier que les fichiers existent ne prouverait rien — et le
 * jour où on en a besoin, c'est le seul jour où ça compte.
 */
const CARD = 'base1-4';
const SESSION = 'test-backup-session';

let dir: string;
let sessionId: string;
let scanId: string;

const bits = (seed: number): string => {
  let s = '';
  for (let i = 0; i < 64; i++) s += ((seed >> i % 31) & 1) === 1 ? '1' : '0';
  return s;
};

const vec = (seed: number): string => {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed * (i + 1)));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return `[${v.map((x) => x / n).join(',')}]`;
};

async function wipe(): Promise<void> {
  await query(`delete from known_fingerprints where card_id = $1`, [CARD]);
  await query(
    `delete from scans where session_id in (select id from sessions where name = $1)`,
    [SESSION],
  );
  await query(`delete from price_history where sku like $1`, [`${CARD}-%`]);
  await query(`delete from channel_events where sku like $1`, [`${CARD}-%`]);
  await query(`delete from inventory where card_id = $1`, [CARD]);
  await query(`delete from sessions where name = $1`, [SESSION]);
}

beforeAll(async () => {
  await wipe();
  dir = await mkdtemp(join(tmpdir(), 'pokelister-backup-'));
  process.env['BACKUP_DIR'] = dir;

  const s = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition, expected_count)
     values ($1,'normal','NM',1) returning id`,
    [SESSION],
  );
  sessionId = s.rows[0]!.id;

  await query(
    `insert into inventory (sku, card_id, variant, condition, language, qty_on_hand)
     values ($1,$2,'normal','NM','en',3)`,
    [`${CARD}-normal-NM-en`, CARD],
  );

  const sc = await query<{ id: string }>(
    `insert into scans (session_id, seq, front_path, phash_front, dhash_front,
                        embedding, status, resolved_sku, match_source, confidence)
     values ($1,1,'/x/1.jpg',$2::bit(64),$3::bit(64),$4::vector,'resolved',$5,'manual',1.0)
     returning id`,
    [sessionId, bits(11), bits(22), vec(3), `${CARD}-normal-NM-en`],
  );
  scanId = sc.rows[0]!.id;

  await query(
    `insert into known_fingerprints
       (card_id, variant, condition, language, phash, dhash, embedding,
        source_scan, confirmed_by)
     values ($1,'normal','NM','en',$2::bit(64),$3::bit(64),$4::vector,$5,'manual')`,
    [CARD, bits(11), bits(22), vec(3), scanId],
  );

  await query(
    `insert into price_history (sku, price, reason) values ($1, 12.34, 'manual')`,
    [`${CARD}-normal-NM-en`],
  );
});

afterAll(async () => {
  await wipe();
  await closePool();
  await rm(dir, { recursive: true, force: true });
});

describe('sauvegarde et restauration', () => {
  it('fait l’aller-retour complet : sauvegarde, effacement, restauration', async () => {
    const before = await snapshot();
    expect(before.fingerprints).toBe(1);
    expect(before.inventory).toBe(1);

    const { dir: backupDir, counts } = await runBackup();
    expect(counts['known_fingerprints']).toBeGreaterThanOrEqual(1);

    const verified = await verifyBackup(backupDir);
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);

    // On EFFACE pour de vrai. C'est le seul moyen de savoir si la restauration
    // fonctionne : un test qui ne détruit rien ne teste rien.
    await wipe();
    const wiped = await snapshot();
    expect(wiped.fingerprints).toBe(0);
    expect(wiped.inventory).toBe(0);

    await runRestore(backupDir);

    const after = await snapshot();
    expect(after.fingerprints).toBe(before.fingerprints);
    expect(after.inventory).toBe(before.inventory);
    expect(after.scans).toBe(before.scans);
    expect(after.priceHistory).toBe(before.priceHistory);
  }, 120_000);

  it('restaure les empreintes À L’IDENTIQUE, bits et vecteur compris', async () => {
    // C'est le point qui casse dans la vraie vie : un bit(64) et un vector(512)
    // ne se réinjectent pas sans cast explicite, et une restauration qui perd
    // les empreintes perd des mois de review manuelle.
    const { rows } = await query<{ phash: string; dhash: string; dims: number }>(
      `select phash::text, dhash::text, vector_dims(embedding) as dims
         from known_fingerprints where card_id = $1`,
      [CARD],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phash).toBe(bits(11));
    expect(rows[0]?.dhash).toBe(bits(22));
    expect(Number(rows[0]?.dims)).toBe(512);
  });

  it('la restauration est rejouable sans créer de doublon', async () => {
    const before = await snapshot();
    await runRestore(join(dir, new Date().toISOString().slice(0, 10)));
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it('détecte un manifeste absent plutôt que de prétendre que tout va bien', async () => {
    const res = await verifyBackup(join(dir, 'nexiste-pas'));
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/manifeste/);
  });
});

async function snapshot(): Promise<{
  fingerprints: number;
  inventory: number;
  scans: number;
  priceHistory: number;
}> {
  const { rows } = await query<{
    fingerprints: string;
    inventory: string;
    scans: string;
    price_history: string;
  }>(
    `select
       (select count(*) from known_fingerprints where card_id = $1)::text as fingerprints,
       (select count(*) from inventory where card_id = $1)::text as inventory,
       (select count(*) from scans s join sessions ss on ss.id = s.session_id
         where ss.name = $2)::text as scans,
       (select count(*) from price_history where sku like $3)::text as price_history`,
    [CARD, SESSION, `${CARD}-%`],
  );
  const r = rows[0]!;
  return {
    fingerprints: Number(r.fingerprints),
    inventory: Number(r.inventory),
    scans: Number(r.scans),
    priceHistory: Number(r.price_history),
  };
}
