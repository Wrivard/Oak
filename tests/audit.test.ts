import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { reopenScan } from '../app/audit/actions.js';
import { applyResolution } from '../lib/resolution.js';

/**
 * Correction d'une résolution automatique erronée.
 *
 * Ce n'est pas un simple « annuler ». Une mauvaise résolution a fait trois
 * choses, et les défaire à moitié laisserait le système dans un état PIRE que
 * l'erreur d'origine — notamment l'empreinte, qui propagerait l'erreur à toutes
 * les occurrences suivantes de la carte par le niveau 1.
 *
 * Ça touche à l'inventaire : c'est du chemin de l'argent, donc c'est testé.
 */
const SESSION = 'test-audit';
const CARD = 'base1-4';
const SKU = `${CARD}-normal-NM-en`;

let sessionId: string;
let seq = 0;

const bits = (n: number): string => {
  let s = '';
  for (let i = 0; i < 64; i++) s += ((n >> i % 31) & 1) === 1 ? '1' : '0';
  return s;
};

const vec = (n: number): string => {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(n * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return `[${v.map((x) => x / norm).join(',')}]`;
};

async function wipe(): Promise<void> {
  await query(`delete from known_fingerprints where card_id = $1`, [CARD]);
  await query(
    `delete from scans where session_id in (select id from sessions where name = $1)`,
    [SESSION],
  );
  await query(`delete from channel_events where sku = $1`, [SKU]);
  await query(`delete from inventory where card_id = $1`, [CARD]);
  await query(`delete from sessions where name = $1`, [SESSION]);
}

/** Une carte résolue automatiquement, comme le ferait le handler `match`. */
async function resolveOne(): Promise<string> {
  seq += 1;
  const { rows } = await query<{ id: string }>(
    `insert into scans (session_id, seq, front_path, phash_front, dhash_front,
                        embedding, status)
     values ($1,$2,'/x.jpg',$3::bit(64),$4::bit(64),$5::vector,'fingerprinted')
     returning id`,
    [sessionId, seq, bits(seq), bits(seq + 100), vec(seq)],
  );
  const scanId = rows[0]!.id;

  await applyResolution({
    scanId,
    identity: { card_id: CARD, variant: 'normal', condition: 'NM', language: 'en' },
    source: 'catalog',
    confidence: 0.9,
    phash: bits(seq),
    dhash: bits(seq + 100),
    embedding: vec(seq),
  });
  return scanId;
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

async function qty(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    'select qty_on_hand as n from inventory where sku = $1',
    [SKU],
  );
  return rows[0]?.n ?? -1;
}

async function fingerprints(scanId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'select count(*)::text as n from known_fingerprints where source_scan = $1',
    [scanId],
  );
  return Number(rows[0]?.n);
}

describe('reopenScan', () => {
  it('défait les TROIS effets : quantité, empreinte, état du scan', async () => {
    const scanId = await resolveOne();
    expect(await qty()).toBe(1);
    expect(await fingerprints(scanId)).toBe(1);

    const res = await reopenScan(scanId);
    expect(res.ok).toBe(true);
    expect(res.empreintesSupprimees).toBe(1);

    expect(await qty()).toBe(0);
    expect(await fingerprints(scanId)).toBe(0);

    const { rows } = await query<{ status: string; sku: string | null; src: string | null }>(
      'select status, resolved_sku as sku, match_source::text as src from scans where id = $1',
      [scanId],
    );
    expect(rows[0]?.status).toBe('needs_review');
    expect(rows[0]?.sku).toBeNull();
    expect(rows[0]?.src).toBeNull();
  });

  it('SUPPRIMER L’EMPREINTE est le point qui compte', async () => {
    // Une empreinte fausse fait hériter la même erreur à toutes les occurrences
    // suivantes par le niveau 1. La laisser en place rendrait la correction
    // pire qu'inutile : l'erreur se reproduirait en silence, sans plus jamais
    // passer par le catalogue.
    const scanId = await resolveOne();
    await reopenScan(scanId);

    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from known_fingerprints where card_id = $1',
      [CARD],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('ne touche qu’UNE unité quand plusieurs exemplaires partagent le SKU', async () => {
    const a = await resolveOne();
    await resolveOne();
    expect(await qty()).toBe(2);

    await reopenScan(a);
    expect(await qty()).toBe(1);
  });

  it('refuse un scan qui n’est pas résolu', async () => {
    const scanId = await resolveOne();
    await reopenScan(scanId);
    const res = await reopenScan(scanId);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/n’est pas résolu/);
  });

  it('refuse quand la quantité tomberait sous zéro', async () => {
    // Le cas réel : la carte a déjà été vendue. Mieux vaut échouer clairement
    // que descendre sous zéro et casser l'invariant d'inventaire.
    const scanId = await resolveOne();
    await query('select apply_qty_delta($1, -1, $2)', [SKU, 'ebay_sale']);
    expect(await qty()).toBe(0);

    const res = await reopenScan(scanId);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/vendue|zéro/);

    // Et RIEN n'a bougé : la transaction a tout annulé.
    expect(await qty()).toBe(0);
    expect(await fingerprints(scanId)).toBe(1);
  });

  it('refuse un scan inexistant', async () => {
    const res = await reopenScan('00000000-0000-0000-0000-000000000000');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/introuvable/);
  });
});
