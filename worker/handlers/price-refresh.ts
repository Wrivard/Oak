import { query, withTransaction } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import { estimateValue } from '../../lib/pricing/estimate.js';
import {
  isAnomalousSwing,
  parsePricingConfig,
  suggestPrice,
  worthPushing,
  type PricingConfig,
} from '../../lib/pricing/rules.js';
import {
  extractPrices,
  fetchEbayComps,
  fetchPricesBatch,
  SourceUnavailable,
  toPriceSources,
  type ApiCard,
  type FetchedPrices,
} from '../../lib/pricing/sources.js';
import { parseSku, type CardCondition, type CardVariant } from '../../lib/sku.js';
import { PermanentError } from '../queue/errors.js';
import type { Job } from '../queue/queue.js';

/**
 * Rafraîchissement des prix. Voir docs/03-pricing.md §5.
 *
 * Avec 12-15k SKUs actifs le pricing est un processus, pas un événement : un
 * batch borné, les cartes chères d'abord.
 */
const BATCH = 500;

interface SkuRow {
  sku: string;
  card_id: string;
  variant: CardVariant;
  condition: CardCondition;
  current_price: string | null;
}

export async function handlePriceRefresh(job: Job): Promise<void> {
  const cfg = await loadConfig();
  const limit = typeof job.payload['limit'] === 'number' ? job.payload['limit'] : BATCH;
  const apiKey = process.env['POKEMONTCG_API_KEY'];

  const { rows } = await query<SkuRow>(
    `select i.sku, i.card_id, i.variant, i.condition, i.current_price::text
       from inventory i
      where i.qty_on_hand > 0
        and (i.last_priced_at is null
             or i.last_priced_at < now() - interval '24 hours')
      order by i.current_price desc nulls first
      limit $1`,
    [limit],
  );

  // Un seul aller-retour réseau pour tout le batch. L'endpoint par identifiant
  // est massivement instable (voir lib/pricing/sources.ts) et 500 appels
  // séparés n'aboutiraient jamais.
  let cards: Map<string, ApiCard>;
  try {
    cards = await fetchPricesBatch(rows.map((r) => r.card_id), apiKey);
  } catch (err) {
    log.warn('source de prix indisponible, batch abandonné', {
      candidats: rows.length,
      err,
    });
    throw err;
  }

  let priced = 0;
  let noData = 0;
  let flagged = 0;
  let unchanged = 0;

  for (const row of rows) {
    try {
      const card = cards.get(row.card_id);
      if (!card) {
        await markNoData(row.sku, { raison: 'carte absente de la source' });
        noData++;
        continue;
      }
      const outcome = await refreshOne(row, extractPrices(card, row.variant), cfg);
      if (outcome === 'priced') priced++;
      else if (outcome === 'no_data') noData++;
      else if (outcome === 'flagged') flagged++;
      else unchanged++;
    } catch (err) {
      // Un SKU qui échoue ne doit pas emporter le batch.
      log.error('rafraîchissement impossible pour un SKU', { sku: row.sku, err });
    }
  }

  log.info('price_refresh terminé', {
    candidats: rows.length,
    priced,
    no_data: noData,
    flagged,
    unchanged,
  });
}

type Outcome = 'priced' | 'no_data' | 'flagged' | 'unchanged';

async function refreshOne(
  row: SkuRow,
  fetched: FetchedPrices,
  cfg: PricingConfig,
): Promise<Outcome> {
  await writePriceCurrent(row.sku, fetched);

  const comps = await fetchEbayComps(row.card_id);
  const estimate = estimateValue(toPriceSources(fetched, comps));

  // `no_data` ne produit JAMAIS de prix. Il envoie en review. Un système qui
  // invente un prix quand il ne sait pas est pire qu'un système qui s'arrête.
  if (estimate.valueCents === null) {
    await markNoData(row.sku, estimate.breakdown);
    return 'no_data';
  }

  // Cardmarket est libellé en EUROS, pas en dollars, et pokemontcg.io ne convertit
  // pas. Mesuré sur de vraies cartes : Charizard Base à 897,19 $ chez TCGplayer
  // contre 4184,60 chez Cardmarket, et sv1-1 à 0,11 $ contre 3,92 — des écarts
  // de 4,7x et 35x. Ce n'est pas une variation de marché, c'est une unité
  // différente doublée d'un marché différent.
  //
  // On ne publie donc JAMAIS un prix issu de ce seul fallback : on l'enregistre
  // et on envoie en review, au même titre qu'une absence de données.
  if (estimate.method === 'cardmarket_fallback') {
    await markNoData(row.sku, {
      ...estimate.breakdown,
      raison: 'cardmarket seul : devise EUR non convertie, non publiable',
    });
    return 'no_data';
  }

  const suggestion = suggestPrice(estimate.valueCents, row.condition, cfg, 'ebay');
  const oldCents =
    row.current_price === null ? null : Math.round(Number(row.current_price) * 100);

  // Un mouvement de plus de 40 % en un cycle est une anomalie de DONNÉES, pas le
  // marché. C'est ce garde-fou qui empêche de lister 3 000 cartes à 0,01 $ la
  // nuit parce qu'une source a renvoyé des centimes.
  if (isAnomalousSwing(oldCents, suggestion.priceCents)) {
    await flagSwing(row.sku, oldCents, suggestion.priceCents, {
      estimate: estimate.breakdown,
      suggestion: suggestion.breakdown,
    });
    return 'flagged';
  }

  // Sans seuil de delta on génère des milliers de révisions par jour pour des
  // variations de quelques cents. Ce n'est pas une limite technique, c'est du
  // bruit et du quota d'appels.
  if (!worthPushing(oldCents, suggestion.priceCents, cfg)) {
    await touchPricedAt(row.sku, estimate, suggestion.priceCents);
    return 'unchanged';
  }

  await applyPrice(row.sku, estimate, suggestion.priceCents, {
    estimate: estimate.breakdown,
    suggestion: suggestion.breakdown,
  });
  return 'priced';
}

async function loadConfig(): Promise<PricingConfig> {
  const { rows } = await query<{ config: unknown }>(
    'select config from pricing_rules where id = 1',
  );
  if (rows.length === 0) {
    // La migration 004 sème cette ligne. Son absence est un problème de schéma,
    // pas quelque chose à contourner avec des valeurs par défaut.
    throw new PermanentError('pricing_rules vide : la migration 004 n’a pas été appliquée');
  }
  return parsePricingConfig(rows[0]?.config);
}

async function writePriceCurrent(sku: string, f: FetchedPrices): Promise<void> {
  const d = (cents: number | null) => (cents === null ? null : (cents / 100).toFixed(2));

  await query(
    `insert into price_current (sku, source, low, mid, high, market, raw, fetched_at)
     values ($1, 'tcgplayer', $2, $3, $4, $5, $6, now())
     on conflict (sku, source) do update
        set low = excluded.low, mid = excluded.mid, high = excluded.high,
            market = excluded.market, raw = excluded.raw,
            fetched_at = excluded.fetched_at`,
    [sku, d(f.tcgLow), d(f.tcgMid), d(f.tcgHigh), d(f.tcgMarket), f.raw],
  );

  if (f.cmTrend !== null) {
    await query(
      `insert into price_current (sku, source, market, fetched_at)
       values ($1, 'cardmarket', $2, now())
       on conflict (sku, source) do update
          set market = excluded.market, fetched_at = excluded.fetched_at`,
      [sku, d(f.cmTrend)],
    );
  }
}

/** Pas de valeur exploitable : on l'enregistre et on envoie en review. */
async function markNoData(sku: string, breakdown: Record<string, unknown>): Promise<void> {
  await query(
    `update inventory
        set value_estimate = null,
            price_breakdown = $2,
            last_priced_at = now(),
            updated_at = now()
      where sku = $1`,
    [sku, { method: 'no_data', details: breakdown }],
  );
  log.info('aucune donnée de prix, SKU laissé sans prix', { sku });
}

async function flagSwing(
  sku: string,
  oldCents: number | null,
  newCents: number,
  breakdown: Record<string, unknown>,
): Promise<void> {
  await query(
    `insert into channel_events (channel, sku, event, payload)
     values ('internal', $1, 'price_swing', $2)`,
    [sku, { old_cents: oldCents, new_cents: newCents, ...breakdown }],
  );
  // On NE pousse pas et on ne met pas à jour current_price.
  await query(
    `update inventory set price_breakdown = $2, updated_at = now() where sku = $1`,
    [sku, { flagged: 'price_swing', old_cents: oldCents, new_cents: newCents }],
  );
  log.warn('mouvement de prix anormal, non poussé', {
    sku,
    old_cents: oldCents,
    new_cents: newCents,
  });
}

async function touchPricedAt(
  sku: string,
  estimate: { valueCents: number | null; breakdown: Record<string, unknown> },
  _priceCents: number,
): Promise<void> {
  await query(
    `update inventory
        set value_estimate = $2, price_breakdown = $3,
            last_priced_at = now(), updated_at = now()
      where sku = $1`,
    [
      sku,
      estimate.valueCents === null ? null : (estimate.valueCents / 100).toFixed(2),
      estimate.breakdown,
    ],
  );
}

async function applyPrice(
  sku: string,
  estimate: { valueCents: number | null; breakdown: Record<string, unknown> },
  priceCents: number,
  breakdown: Record<string, unknown>,
): Promise<void> {
  const price = (priceCents / 100).toFixed(2);

  await withTransaction(async (client) => {
    await client.query(
      `update inventory
          set value_estimate = $2, current_price = $3, price_breakdown = $4,
              last_priced_at = now(), updated_at = now()
        where sku = $1`,
      [
        sku,
        estimate.valueCents === null ? null : (estimate.valueCents / 100).toFixed(2),
        price,
        breakdown,
      ],
    );
    // Chaque changement laisse une trace : c'est le seul recours pour comprendre
    // un mois de ventes bizarres.
    await client.query(
      `insert into price_history (sku, price, reason, breakdown)
       values ($1, $2, 'reprice', $3)`,
      [sku, price, breakdown],
    );
  });
}

/** Le SKU porte déjà l'identité : pas de requête supplémentaire pour la retrouver. */
export function identityFromSku(sku: string): ReturnType<typeof parseSku> {
  return parseSku(sku);
}
