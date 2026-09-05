import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { confirmExport, handleTcgExport } from '../worker/handlers/tcg-export.js';
import type { Job } from '../worker/queue/queue.js';

/**
 * L'invariant qui protège l'inventaire (docs/04 §B.2).
 *
 * `tcg_qty_pushed` ne bouge QU'À la confirmation d'un import réussi. Tant que
 * la confirmation n'a pas eu lieu, le delta du prochain export reste correct :
 * un upload raté ne corrompt rien, et une double confirmation n'applique le
 * delta qu'une fois.
 */
const CARD = 'base1-4';
const SKU = `${CARD}-normal-NM-en`;
let dir: string;

const job = (key: string): Job => ({
  id: 0,
  type: 'tcg_export',
  payload: {},
  idempotency_key: key,
  status: 'running',
  priority: 100,
  attempts: 1,
  max_attempts: 5,
});

async function wipe(): Promise<void> {
  await query(`delete from channel_events where channel = 'tcgplayer'`);
  await query(`delete from inventory where card_id = $1`, [CARD]);
}

beforeEach(async () => {
  await wipe();
  dir = dir ?? (await mkdtemp(join(tmpdir(), 'pokelister-export-')));
  process.env['TCG_EXPORT_DIR'] = dir;

  await query(
    `insert into inventory (sku, card_id, variant, condition, language,
                            qty_on_hand, tcg_sku_id, current_price, tcg_dirty)
     values ($1,$2,'normal','NM','en',5,'999001',10.00,true)`,
    [SKU, CARD],
  );
});

afterAll(async () => {
  await wipe();
  await closePool();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function pushed(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    'select tcg_qty_pushed as n from inventory where sku = $1',
    [SKU],
  );
  return rows[0]?.n ?? -1;
}

describe('export TCGplayer', () => {
  it('générer le CSV ne touche PAS à tcg_qty_pushed', async () => {
    // Le coeur de l'invariant. Si la génération avançait le compteur, un upload
    // raté laisserait un delta faux le lendemain — dans le sens qui fait
    // disparaître du stock.
    await handleTcgExport(job('tcg_export:test-1'));
    expect(await pushed()).toBe(0);
  });

  it('la confirmation applique le delta une fois', async () => {
    await handleTcgExport(job('tcg_export:test-2'));
    const res = await confirmExport('tcg_export:test-2');
    expect(res.applied).toBe(1);
    expect(await pushed()).toBe(5);
  });

  it('confirmer DEUX fois n’applique le delta qu’une fois', async () => {
    // Un double clic ne doit pas doubler l'inventaire — c'est précisément le
    // bug que tcg_qty_pushed existe pour empêcher.
    await handleTcgExport(job('tcg_export:test-3'));
    await confirmExport('tcg_export:test-3');
    const second = await confirmExport('tcg_export:test-3');

    expect(second.alreadyConfirmed).toBe(true);
    expect(second.applied).toBe(0);
    expect(await pushed()).toBe(5);
  });

  it('un deuxième export après confirmation ne contient plus rien', async () => {
    await handleTcgExport(job('tcg_export:test-4a'));
    await confirmExport('tcg_export:test-4a');

    await handleTcgExport(job('tcg_export:test-4b'));
    const { rows } = await query<{ payload: { lignes: number } }>(
      `select payload from channel_events
        where event = 'export_generated' and payload->>'batch_id' = $1`,
      ['tcg_export:test-4b'],
    );
    // Cible 5, déjà poussé 5 : delta nul, donc aucune ligne.
    expect(rows[0]?.payload.lignes).toBe(0);
  });

  it('une vente ailleurs produit un delta négatif au prochain export', async () => {
    await handleTcgExport(job('tcg_export:test-5a'));
    await confirmExport('tcg_export:test-5a');

    await query('select apply_qty_delta($1, -2, $2)', [SKU, 'ebay_sale']);

    await handleTcgExport(job('tcg_export:test-5b'));
    const { rows } = await query<{
      payload: { deltas: { sku: string; delta: number }[] };
    }>(
      `select payload from channel_events
        where event = 'export_generated' and payload->>'batch_id' = $1`,
      ['tcg_export:test-5b'],
    );
    expect(rows[0]?.payload.deltas[0]?.delta).toBe(-2);
  });

  it('regénérer le même lot ne produit pas un second fichier', async () => {
    // Deux fichiers avec les mêmes deltas finiraient tous les deux uploadés.
    await handleTcgExport(job('tcg_export:test-6'));
    await handleTcgExport(job('tcg_export:test-6'));

    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from channel_events
        where event = 'export_generated' and payload->>'batch_id' = $1`,
      ['tcg_export:test-6'],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('confirmer un lot inexistant échoue clairement', async () => {
    await expect(confirmExport('tcg_export:nexiste-pas')).rejects.toThrow(/introuvable/);
  });
});
