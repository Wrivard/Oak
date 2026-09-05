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
import {
  buildQuery,
  ebayEnvFromProcess,
  EbayNotEntitled,
  EbayUnavailable,
  fetchActiveListings,
  fetchSoldListings,
  SOLD_WINDOW_DAYS,
  type CompsSummary,
  type EbayEnv,
} from '../../lib/pricing/ebay-comps.js';
import { parseSku, type CardCondition, type CardVariant } from '../../lib/sku.js';
import { PermanentError } from '../queue/errors.js';
import type { Job } from '../queue/queue.js';
import { withBreaker } from '../queue/breaker.js';
import { trace } from '../queue/trace.js';

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
  card_name: string;
  card_number: string;
  printed_total: number | null;
}

/**
 * Marketplace Insights est en Limited Release. Un premier 403 suffit à savoir
 * que le compte n'est pas whitelisté : on cesse d'essayer pour tout le batch
 * plutôt que de brûler 500 appels voués au même refus.
 */
let insightsEntitled = true;

export async function handlePriceRefresh(job: Job): Promise<void> {
  const cfg = await loadConfig();
  const limit = typeof job.payload['limit'] === 'number' ? job.payload['limit'] : BATCH;
  const apiKey = process.env['POKEMONTCG_API_KEY'];
  const ebay = ebayEnvFromProcess();
  if (!ebay) {
    log.info('eBay non configuré : ni annonces actives ni ventes passées', {
      manquant: 'EBAY_CLIENT_ID / EBAY_CLIENT_SECRET',
    });
  }

  const { rows } = await query<SkuRow>(
    `select i.sku, i.card_id, i.variant, i.condition, i.current_price::text,
            c.name as card_name, c.number as card_number, c.printed_total
       from inventory i join cards c on c.id = i.card_id
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
    const ids = rows.map((r) => r.card_id);
    cards = await trace(
      'pokemontcg',
      'cards_batch',
      () => withBreaker('pokemontcg', () => fetchPricesBatch(ids, apiKey)),
      (res) => ({ ok: true, context: { demandes: ids.length, recues: res.size } }),
    );
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
      const outcome = await refreshOne(row, extractPrices(card, row.variant), cfg, ebay);
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
  ebay: EbayEnv | null,
): Promise<Outcome> {
  await writePriceCurrent(row.sku, fetched);

  // Comparables eBay : annonces actives et ventes passées, en TOTAL prix + port.
  const { active, sold } = await fetchEbayBoth(row, ebay);
  if (active) await writeComps(row.sku, 'ebay_active', active, null);
  if (sold) await writeComps(row.sku, 'ebay_sold', sold, SOLD_WINDOW_DAYS);

  // Le moteur consomme les VENTES passées, pas les annonces actives : une
  // annonce est un prix demandé, pas un prix obtenu. Les actives servent à
  // l'oeil humain dans la review, pas au calcul.
  const comps = sold ? sold.observations.map((o) => o.totalCents) : await fetchEbayComps(row.card_id);
  const estimate = estimateValue(toPriceSources(fetched, comps));

  // `no_data` ne produit JAMAIS de prix. Il envoie en review. Un système qui
  // invente un prix quand il ne sait pas est pire qu'un système qui s'arrête.
  if (estimate.valueCents === null) {
    // Le printing demandé absent de la source est une raison DISTINCTE d'une
    // absence totale de données, et c'est celle qui se corrige : soit le lot a
    // été envoyé avec le mauvais variant, soit l'API n'a pas ce printing. La
    // review doit voir laquelle.
    const absent = row.variant !== undefined && fetched.raw['printing_absent'] === true;
    await markNoData(row.sku, {
      ...estimate.breakdown,
      ...(absent
        ? {
            raison:
              `printing « ${row.variant} » absent de la source ` +
              `(disponibles : ${JSON.stringify(fetched.raw['printings_disponibles'])}) — ` +
              `aucun autre printing n'est substitué, l'écart normal/reverse va de 5x à 20x`,
          }
        : {}),
    });
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

/**
 * Récupère les deux jeux de comparables sans laisser eBay faire tomber le
 * pricing : une indisponibilité côté eBay ne doit pas empêcher de prixer sur les
 * données TCGplayer déjà en main.
 */
async function fetchEbayBoth(
  row: SkuRow,
  ebay: EbayEnv | null,
): Promise<{ active: CompsSummary | null; sold: CompsSummary | null }> {
  if (!ebay) return { active: null, sold: null };

  const q = buildQuery(row.card_name, row.card_number, row.printed_total);

  let active: CompsSummary | null = null;
  try {
    active = await trace(
      'ebay',
      'browse_active',
      () => withBreaker('ebay', () => fetchActiveListings(ebay, q)),
      (res) => ({ ok: true, context: { sku: row.sku, requete: q, retenues: res.count } }),
    );
  } catch (err) {
    if (!(err instanceof EbayUnavailable)) throw err;
    log.warn('annonces actives indisponibles', { sku: row.sku, err });
  }

  let sold: CompsSummary | null = null;
  if (insightsEntitled) {
    try {
      // Un refus de whitelisting n'est PAS une panne du service : il ne doit
      // pas ouvrir le circuit, sinon un compte non autorisé couperait aussi les
      // annonces actives, qui elles fonctionnent.
      sold = await trace(
        'ebay',
        'insights_sold',
        () =>
          withBreaker(
            'ebay',
            () => fetchSoldListings(ebay, q),
            (e) => !(e instanceof EbayNotEntitled),
          ),
        (res) => ({ ok: true, context: { sku: row.sku, requete: q, ventes: res.count } }),
      );
    } catch (err) {
      if (err instanceof EbayNotEntitled) {
        // Inutile de réessayer 499 fois : le compte n'est pas whitelisté.
        insightsEntitled = false;
        log.warn('Marketplace Insights non accordé, ventes passées désactivées', { err });
      } else if (err instanceof EbayUnavailable) {
        log.warn('ventes passées indisponibles', { sku: row.sku, err });
      } else {
        throw err;
      }
    }
  }

  return { active, sold };
}

/**
 * Écrit un jeu de comparables dans `price_current`.
 *
 *   market  médiane des totaux — c'est ce que le moteur utilise
 *   mid     MOYENNE des totaux — c'est le chiffre demandé à l'écran
 *   low/high min et max
 *   raw     les observations individuelles, dates comprises
 *
 * Les deux sont stockées volontairement : l'écart entre moyenne et médiane est
 * lui-même un signal. Quand il est grand, la recherche plein texte a ramené du
 * bruit — un lot, une carte gradée — et le chiffre est à regarder de près.
 */
async function writeComps(
  sku: string,
  source: 'ebay_active' | 'ebay_sold',
  c: CompsSummary,
  windowDays: number | null,
): Promise<void> {
  if (c.count === 0) return;
  const d = (cents: number | null) => (cents === null ? null : (cents / 100).toFixed(2));

  await query(
    `insert into price_current
       (sku, source, low, mid, high, market, n_sales, window_days, raw, fetched_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (sku, source) do update
        set low = excluded.low, mid = excluded.mid, high = excluded.high,
            market = excluded.market, n_sales = excluded.n_sales,
            window_days = excluded.window_days, raw = excluded.raw,
            fetched_at = excluded.fetched_at`,
    [
      sku,
      source,
      d(c.lowCents),
      d(c.averageCents),
      d(c.highCents),
      d(c.medianCents),
      c.count,
      windowDays,
      {
        moyenne_cents: c.averageCents,
        mediane_cents: c.medianCents,
        // Bornées : on veut la traçabilité, pas un dump de 50 annonces par SKU.
        observations: c.observations.slice(0, 20).map((o) => ({
          total_cents: o.totalCents,
          prix_cents: o.priceCents,
          port_cents: o.shippingCents,
          vendu_le: o.soldAt ?? null,
          titre: o.title.slice(0, 120),
        })),
      },
    ],
  );
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
