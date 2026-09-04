import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { handleMatch } from '../worker/handlers/match.js';
import { parseNumberText } from '../lib/ocr/number.js';
import { buildSku } from '../lib/sku.js';
import type { Job } from '../worker/queue/queue.js';

/**
 * Les chemins de résolution, testés contre la vraie base.
 *
 * L'OCR n'est pas exercé ici : il a son propre régime d'incertitude et c'est
 * l'expérience 1bis qui doit le mesurer, sur de vrais scans. Ce qui est vérifié
 * ici, c'est ce qui se passe APRÈS — la résolution niveau 1, les effets de bord
 * sur l'inventaire, le conflit de variant, et l'idempotence.
 */
const SESSION = 'test-match-session';
const CARD = 'base1-4';

let sessionId: string;
let seq = 0;

/** Empreinte arbitraire mais déterministe, en littéral bit(64). */
function bits(seed: number): string {
  let s = '';
  for (let i = 0; i < 64; i++) s += ((seed >> i % 31) & 1) === 1 ? '1' : '0';
  return s;
}

/** Vecteur normalisé L2, littéral pgvector. */
function vec(seed: number): string {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed * (i + 1)));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return `[${v.map((x) => x / n).join(',')}]`;
}

async function makeScan(opts: {
  phash: string;
  dhash: string;
  embedding: string;
}): Promise<string> {
  seq += 1;
  const { rows } = await query<{ id: string }>(
    `insert into scans (session_id, seq, front_path, phash_front, dhash_front,
                        embedding, status)
     values ($1,$2,$3,$4::bit(64),$5::bit(64),$6::vector,'fingerprinted')
     returning id`,
    [sessionId, seq, `/inexistant/${seq}.jpg`, opts.phash, opts.dhash, opts.embedding],
  );
  return rows[0]!.id;
}

const job = (scanId: string): Job => ({
  id: 0,
  type: 'match',
  payload: { scan_id: scanId },
  idempotency_key: `match:${scanId}`,
  status: 'running',
  priority: 100,
  attempts: 1,
  max_attempts: 5,
});

async function cleanup(): Promise<void> {
  // Toutes les empreintes de la carte de test, pas seulement celles rattachées à
  // un scan : les fixtures sont semées avec source_scan nul et survivraient au
  // nettoyage. Une empreinte oubliée ferait résoudre les runs suivants en
  // niveau 1 sans qu'on comprenne pourquoi.
  await query(`delete from known_fingerprints where card_id = $1`, [CARD]);
  await query(
    `delete from channel_events where sku like $1`,
    [`${CARD}-%`],
  );
  await query(
    `delete from scans where session_id in (select id from sessions where name=$1)`,
    [SESSION],
  );
  await query(`delete from inventory where card_id = $1`, [CARD]);
  await query(`delete from sessions where name = $1`, [SESSION]);
}

beforeAll(async () => {
  await cleanup();
  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition, default_language)
     values ($1,'normal','NM','en') returning id`,
    [SESSION],
  );
  sessionId = rows[0]!.id;
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

describe('parseNumberText', () => {
  it('lit la forme fractionnaire et retire les zéros de tête', () => {
    expect(parseNumberText('004/102')).toMatchObject({ number: '4', printedTotal: 102 });
    expect(parseNumberText('bruit 25 / 165 bruit')).toMatchObject({
      number: '25',
      printedTotal: 165,
    });
  });

  it('lit une promo sans dénominateur', () => {
    expect(parseNumberText('SWSH284')).toMatchObject({
      number: 'SWSH284',
      printedTotal: null,
    });
  });

  it('ne rend rien sur du texte sans numéro', () => {
    expect(parseNumberText('weakness resistance retreat')).toBeNull();
  });
});

describe('niveau 1 — known_fingerprints', () => {
  it('résout, crée le SKU, incrémente la quantité et nourrit les empreintes', async () => {
    const p = bits(12345);
    const d = bits(54321);
    const e = vec(7);

    // Une empreinte connue, comme si une review manuelle l'avait confirmée.
    await query(
      `insert into known_fingerprints
         (card_id, variant, condition, language, phash, dhash, embedding, confirmed_by)
       values ($1,'normal','NM','en',$2::bit(64),$3::bit(64),$4::vector,'manual')`,
      [CARD, p, d, e],
    );

    const scanId = await makeScan({ phash: p, dhash: d, embedding: e });
    await handleMatch(job(scanId));

    const sku = buildSku({
      card_id: CARD,
      variant: 'normal',
      condition: 'NM',
      language: 'en',
    });

    const { rows: scans } = await query<{ status: string; match_source: string; resolved_sku: string }>(
      'select status, match_source, resolved_sku from scans where id=$1',
      [scanId],
    );
    expect(scans[0]?.status).toBe('resolved');
    expect(scans[0]?.match_source).toBe('own_history');
    expect(scans[0]?.resolved_sku).toBe(sku);

    const { rows: inv } = await query<{ qty_on_hand: number }>(
      'select qty_on_hand from inventory where sku=$1',
      [sku],
    );
    expect(inv[0]?.qty_on_hand).toBe(1);

    // Skill §7 : un chemin de résolution qui n'alimente pas known_fingerprints
    // est un bug. La bibliothèque doit avoir grandi.
    const { rows: fps } = await query<{ n: string }>(
      `select count(*)::text as n from known_fingerprints
        where card_id=$1 and source_scan=$2`,
      [CARD, scanId],
    );
    expect(Number(fps[0]?.n)).toBe(1);
  });

  it('un deuxième exemplaire incrémente le MÊME SKU au lieu d’en créer un autre', async () => {
    // C'est l'invariant 1 : une carte physique n'est pas une ligne d'annonce,
    // elle incrémente un SKU.
    const p = bits(12345);
    const d = bits(54321);
    const scanId = await makeScan({ phash: p, dhash: d, embedding: vec(7) });
    await handleMatch(job(scanId));

    const sku = buildSku({
      card_id: CARD,
      variant: 'normal',
      condition: 'NM',
      language: 'en',
    });
    const { rows } = await query<{ qty_on_hand: number }>(
      'select qty_on_hand from inventory where sku=$1',
      [sku],
    );
    expect(rows[0]?.qty_on_hand).toBe(2);

    const { rows: lignes } = await query<{ n: string }>(
      'select count(*)::text as n from inventory where card_id=$1',
      [CARD],
    );
    expect(Number(lignes[0]?.n)).toBe(1);
  });

  it('rejouer le même job ne double pas la quantité', async () => {
    const p = bits(12345);
    const d = bits(54321);
    const scanId = await makeScan({ phash: p, dhash: d, embedding: vec(7) });

    await handleMatch(job(scanId));
    await handleMatch(job(scanId)); // rejeu : le scan n'est plus 'fingerprinted'
    await handleMatch(job(scanId));

    const sku = buildSku({
      card_id: CARD,
      variant: 'normal',
      condition: 'NM',
      language: 'en',
    });
    const { rows } = await query<{ qty_on_hand: number }>(
      'select qty_on_hand from inventory where sku=$1',
      [sku],
    );
    expect(rows[0]?.qty_on_hand).toBe(3); // +1 pour ce scan, pas +3
  });

  it('un variant divergent force la review et ne touche à aucune quantité', async () => {
    // Skill §6 : reverse holo vs normal, c'est 5 à 20x d'écart de prix. On ne
    // tranche jamais à la machine.
    const p = bits(999);
    const d = bits(888);
    await query(
      `insert into known_fingerprints
         (card_id, variant, condition, language, phash, dhash, embedding, confirmed_by)
       values ($1,'reverseHolofoil','NM','en',$2::bit(64),$3::bit(64),$4::vector,'manual')`,
      [CARD, p, d, vec(11)],
    );

    const before = await totalQty();
    const scanId = await makeScan({ phash: p, dhash: d, embedding: vec(11) });
    await handleMatch(job(scanId));

    const { rows } = await query<{ status: string; variant_conflict: boolean }>(
      'select status, variant_conflict from scans where id=$1',
      [scanId],
    );
    expect(rows[0]?.status).toBe('needs_review');
    expect(rows[0]?.variant_conflict).toBe(true);
    expect(await totalQty()).toBe(before);
  });
});

async function totalQty(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'select coalesce(sum(qty_on_hand),0)::text as n from inventory where card_id=$1',
    [CARD],
  );
  return Number(rows[0]?.n);
}
