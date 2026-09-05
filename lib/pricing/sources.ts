import { log } from '../log.js';
import type { CardVariant } from '../sku.js';
import type { PriceSources } from './estimate.js';

/**
 * Sources de prix externes. Voir docs/03-pricing.md §1.
 *
 * Ce module n'est appelé QUE depuis un handler de job. Invariant 4 de CLAUDE.md :
 * aucun appel API externe dans une requête HTTP.
 *
 * Ce qui ne marchera pas, et sur quoi il ne faut pas perdre de soirée :
 *   - l'API officielle eBay. La Finding API est morte, les ventes complétées sont
 *     derrière Marketplace Insights, en limited release whitelistée par partenaire.
 *   - l'API TCGplayer directe. Le processus développeur public est fermé depuis
 *     le rachat par eBay.
 * On passe par pokemontcg.io, qui expose les points de prix TCGplayer.
 *
 * ATTENTION — mesuré le 2026-09-04 : l'endpoint `/cards/{id}` renvoie du 500/502
 * de façon massive (4 échecs sur 5 en échantillonnage). La forme requête
 * `/cards?q=id:…` tient mieux et accepte plusieurs identifiants par appel. On
 * passe donc par elle, en LOT : un batch de 500 SKUs devient 5 appels au lieu de
 * 500, ce qui réduit d'autant l'exposition à l'instabilité et au quota.
 */
const API = 'https://api.pokemontcg.io/v2/cards';
const TIMEOUT_MS = 20_000;
const IDS_PER_CALL = 100;
const RETRIES = 3;

/** Erreur transitoire : le handler doit retenter, pas mourir. */
export class SourceUnavailable extends Error {
  override readonly name = 'SourceUnavailable';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface TcgPricePoint {
  low?: number | null;
  mid?: number | null;
  high?: number | null;
  market?: number | null;
  directLow?: number | null;
}

interface ApiCard {
  id: string;
  tcgplayer?: {
    url?: string;
    updatedAt?: string;
    prices?: Record<string, TcgPricePoint | undefined>;
  };
  cardmarket?: {
    prices?: { trendPrice?: number | null; averageSellPrice?: number | null };
  };
}

export interface FetchedPrices {
  tcgMarket: number | null;
  tcgMid: number | null;
  tcgLow: number | null;
  tcgHigh: number | null;
  cmTrend: number | null;
  tcgplayerUrl: string | null;
  raw: Record<string, unknown>;
}

/** Dollars flottants de l'API → cents entiers. Null reste null. */
function toCents(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Un appel, avec quelques reprises courtes.
 *
 * La reprise ici est complémentaire du backoff de la file, pas redondante : elle
 * absorbe un hoquet de quelques secondes sans faire échouer tout un batch de
 * 500 SKUs, alors que le backoff de la file gère une panne durable.
 */
async function callApi(ids: readonly string[], apiKey?: string): Promise<ApiCard[]> {
  const params = new URLSearchParams({
    q: ids.map((id) => `id:"${id}"`).join(' OR '),
    select: 'id,tcgplayer,cardmarket',
    pageSize: String(Math.max(ids.length, 1)),
  });
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-Api-Key'] = apiKey;

  let last: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${API}?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.ok) {
        const body = (await res.json()) as { data?: ApiCard[] };
        return body.data ?? [];
      }

      // 429 et 5xx : transitoires. 4xx autres : notre requête est fautive, et
      // retenter ne la réparera pas.
      if (res.status !== 429 && res.status < 500) {
        throw new SourceUnavailable(`pokemontcg.io ${res.status} (requête refusée)`, res.status);
      }
      last = new SourceUnavailable(`pokemontcg.io ${res.status}`, res.status);
    } catch (err) {
      if (err instanceof SourceUnavailable && err.status < 500 && err.status !== 429) throw err;
      last = err;
    }

    if (attempt < RETRIES) {
      const wait = 2 ** attempt * 500;
      log.debug('source de prix en échec, reprise', { attempt, wait_ms: wait });
      await sleep(wait);
    }
  }

  throw last instanceof SourceUnavailable
    ? last
    : new SourceUnavailable(`pokemontcg.io injoignable: ${String(last)}`, 503);
}

/**
 * Prix de plusieurs cartes en un minimum d'appels.
 *
 * Une carte absente de la réponse n'est PAS une erreur : elle n'existe pas en
 * amont, et son SKU sera traité comme `no_data`.
 */
export async function fetchPricesBatch(
  cardIds: readonly string[],
  apiKey?: string,
): Promise<Map<string, ApiCard>> {
  const out = new Map<string, ApiCard>();
  const unique = [...new Set(cardIds)];

  for (let i = 0; i < unique.length; i += IDS_PER_CALL) {
    const slice = unique.slice(i, i + IDS_PER_CALL);
    for (const card of await callApi(slice, apiKey)) {
      out.set(card.id, card);
    }
  }
  return out;
}

/**
 * Extrait les points de prix pour un printing donné.
 *
 * `tcgplayer.prices` est indexé par printing et nos `card_variant` mappent 1:1
 * dessus. `market` peut être null quand aucune annonce active n'existe pour ce
 * printing — c'est fréquent, pas exceptionnel, et un null non gardé qui plante un
 * batch de 1 700 cartes à 3 h du matin coûte une nuit.
 *
 * ON NE SUBSTITUE JAMAIS UN AUTRE PRINTING. Cette fonction retombait sur le
 * premier printing disponible quand celui demandé manquait : un SKU
 * `reverseHolofoil` dont l'API n'a que `normal` était donc prixé au prix du
 * normal, publié, vendu. C'est exactement l'erreur à 5-20x que tout le reste du
 * système refuse — « il ne devine jamais le variant », et un `variant_conflict`
 * force la review quelle que soit la confiance.
 *
 * docs/03 §1 ne décrit qu'une seule chaîne de repli, et elle reste DANS le
 * printing : `market` → `mid` → `cm_trend`. Un printing absent ne donne donc
 * aucun prix TCGplayer ; l'estimation retombe sur Cardmarket seul, qui n'est pas
 * publiable non plus (EUR non converti), et la carte part en review. S'arrêter
 * vaut mieux qu'inventer.
 */
export function extractPrices(card: ApiCard, variant: CardVariant): FetchedPrices {
  const prices = card.tcgplayer?.prices ?? {};
  const point = prices[variant];
  const disponibles = Object.keys(prices).filter((k) => prices[k] !== undefined);

  return {
    tcgMarket: toCents(point?.market),
    tcgMid: toCents(point?.mid),
    tcgLow: toCents(point?.low),
    tcgHigh: toCents(point?.high),
    cmTrend: toCents(card.cardmarket?.prices?.trendPrice),
    tcgplayerUrl: card.tcgplayer?.url ?? null,
    raw: {
      printing_demande: variant,
      printing_utilise: point ? variant : null,
      // Ce que l'API avait, pour que la review comprenne d'un coup d'oeil
      // pourquoi la carte est là : « tu as demandé reverseHolofoil, l'API n'a
      // que normal ».
      printings_disponibles: disponibles,
      printing_absent: point === undefined,
      tcgplayer_updated_at: card.tcgplayer?.updatedAt ?? null,
      point: point ?? null,
    },
  };
}

/**
 * Ventes eBay récentes.
 *
 * NON IMPLÉMENTÉ, et c'est délibéré : le choix de la source dépend de
 * l'expérience 1 de PROMPTS.md (tcgapi.net vs pokemonpricetracker), qui n'a pas
 * tourné. Écrire un client pour une source non validée serait du code à jeter.
 *
 * En attendant, `estimateValue` retombe sur `tcg_only`, ce qui est le
 * comportement correct — pas un prix inventé.
 */
export async function fetchEbayComps(_cardId: string): Promise<number[]> {
  return [];
}

export function toPriceSources(f: FetchedPrices, comps: readonly number[]): PriceSources {
  return {
    ebaySold: comps,
    tcgMarket: f.tcgMarket,
    tcgMid: f.tcgMid,
    cmTrend: f.cmTrend,
  };
}

export type { ApiCard };
