import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, withTransaction } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import {
  buildRows,
  toCsv,
  type CsvRow,
  type InventoryLine,
} from '../../lib/channels/tcgplayer-csv.js';
import type { Job } from '../queue/queue.js';

/**
 * Export quotidien vers TCGplayer. Voir docs/04-channels.md partie B.
 *
 * Option 1 du doc : **CSV manuel assisté**. L'app génère le fichier, un humain
 * l'uploade dans le Seller Portal. Zéro fragilité, deux minutes par jour. Le
 * Playwright headless viendra si le manuel devient pénible — pas avant.
 *
 * L'INVARIANT DE CE MODULE : `tcg_qty_pushed` n'est JAMAIS touché ici. Il ne
 * bouge qu'à la confirmation d'un import réussi (`confirmExport`). Si l'upload
 * échoue ou n'a pas lieu, le delta du lendemain reste correct.
 */
const EXPORT_DIR = process.env['TCG_EXPORT_DIR'] ?? './exports';

interface Row {
  sku: string;
  tcg_sku_id: string | null;
  qty_on_hand: number;
  qty_reserved_tcg: number;
  tcg_qty_pushed: number;
  current_price: string | null;
  card_name: string;
  set_name: string;
  condition: string;
}

export async function handleTcgExport(job: Job): Promise<void> {
  const batchId =
    typeof job.idempotency_key === 'string' && job.idempotency_key !== ''
      ? job.idempotency_key
      : `tcg_export:${new Date().toISOString().slice(0, 10)}`;

  // Déjà généré aujourd'hui : ne pas produire un second fichier avec les mêmes
  // deltas, quelqu'un finirait par uploader les deux.
  const existing = await query(
    `select 1 from channel_events
      where channel = 'tcgplayer' and event = 'export_generated'
        and payload->>'batch_id' = $1`,
    [batchId],
  );
  if (existing.rows.length > 0) {
    log.info('export TCGplayer déjà généré, job ignoré', { batch_id: batchId });
    return;
  }

  const { rows } = await query<Row>(
    `select i.sku, i.tcg_sku_id, i.qty_on_hand, i.qty_reserved_tcg,
            i.tcg_qty_pushed, i.current_price::text,
            c.name as card_name, c.set_name, i.condition::text as condition
       from inventory i join cards c on c.id = i.card_id
      where i.tcg_dirty = true or i.tcg_qty_pushed <> greatest(i.qty_on_hand - i.qty_reserved_tcg, 0)
      order by i.sku`,
  );

  const lines: InventoryLine[] = rows.map((r) => ({
    sku: r.sku,
    tcg_sku_id: r.tcg_sku_id,
    qty_on_hand: r.qty_on_hand,
    qty_reserved_tcg: r.qty_reserved_tcg,
    tcg_qty_pushed: r.tcg_qty_pushed,
    priceCents: r.current_price === null ? null : Math.round(Number(r.current_price) * 100),
    card_name: r.card_name,
    set_name: r.set_name,
    condition: r.condition,
  }));

  const { rows: csvRows, skipped } = buildRows(lines);

  await mkdir(EXPORT_DIR, { recursive: true });
  const path = join(EXPORT_DIR, `${batchId.replace(/[:]/g, '_')}.csv`);
  await writeFile(path, toCsv(csvRows), 'utf-8');

  // Le lot est enregistré AVEC ses deltas : c'est ce qui permet de confirmer
  // exactement ce qui a été uploadé, même des heures plus tard.
  await query(
    `insert into channel_events (channel, event, payload)
     values ('tcgplayer', 'export_generated', $1)`,
    [
      {
        batch_id: batchId,
        path,
        lignes: csvRows.length,
        deltas: csvRows.map((r: CsvRow) => ({ sku: r.sku, delta: r.addToQuantity })),
        ecartees: summarizeSkips(skipped),
      },
    ],
  );

  log.info('export TCGplayer généré', {
    batch_id: batchId,
    path,
    lignes: csvRows.length,
    ecartees: skipped.length,
    detail_ecartees: summarizeSkips(skipped),
  });
}

function summarizeSkips(
  skipped: readonly { reason: string }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}

/**
 * Confirme qu'un lot a bien été importé chez TCGplayer.
 *
 * C'est le SEUL endroit où `tcg_qty_pushed` avance. Tant que cette fonction n'a
 * pas été appelée, le delta du prochain export reste correct — un upload raté
 * ne corrompt rien.
 *
 * Idempotent : confirmer deux fois le même lot n'applique le delta qu'une fois.
 * Sans ça, un double clic doublerait l'inventaire — exactement le bug que
 * `tcg_qty_pushed` existe pour empêcher.
 */
export async function confirmExport(batchId: string): Promise<{
  applied: number;
  alreadyConfirmed: boolean;
}> {
  const { rows } = await query<{
    payload: { deltas?: { sku: string; delta: number }[] };
  }>(
    `select payload from channel_events
      where channel = 'tcgplayer' and event = 'export_generated'
        and payload->>'batch_id' = $1`,
    [batchId],
  );
  const deltas = rows[0]?.payload.deltas;
  if (!deltas) throw new Error(`lot ${batchId} introuvable`);

  return withTransaction(async (client) => {
    // Verrou logique : la confirmation est enregistrée AVANT d'appliquer, dans
    // la même transaction. Deux confirmations concurrentes, une seule gagne.
    const already = await client.query(
      `select 1 from channel_events
        where channel = 'tcgplayer' and event = 'export_confirmed'
          and payload->>'batch_id' = $1
        for update`,
      [batchId],
    );
    if (already.rows.length > 0) {
      log.warn('lot déjà confirmé, aucune quantité appliquée', { batch_id: batchId });
      return { applied: 0, alreadyConfirmed: true };
    }

    await client.query(
      `insert into channel_events (channel, event, payload)
       values ('tcgplayer', 'export_confirmed', $1)`,
      [{ batch_id: batchId, lignes: deltas.length }],
    );

    for (const d of deltas) {
      await client.query(
        `update inventory
            set tcg_qty_pushed = tcg_qty_pushed + $2,
                tcg_dirty = false,
                updated_at = now()
          where sku = $1`,
        [d.sku, d.delta],
      );
    }

    log.info('export TCGplayer confirmé', { batch_id: batchId, lignes: deltas.length });
    return { applied: deltas.length, alreadyConfirmed: false };
  });
}
