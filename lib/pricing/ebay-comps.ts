import { log } from '../log.js';

/**
 * Comparables eBay : annonces actives et ventes passées.
 *
 * Ce module n'est appelé QUE depuis un handler de job (invariant 4).
 *
 * DEUX API, DEUX NIVEAUX D'ACCÈS — vérifié le 2026-09-05 :
 *
 *   Browse API              annonces ACTIVES. Accessible avec des credentials
 *                           applicatifs standards (client_credentials).
 *   Marketplace Insights    ventes PASSÉES, 90 jours. « Limited Release » :
 *                           eBay réserve l'accès aux gros partenaires et refuse
 *                           les demandes individuelles. Si l'accès n'est pas
 *                           accordé, l'appel renvoie 403 et on se rabat sur la
 *                           source tierce de l'expérience 1.
 *
 * Le total qui compte est TOUJOURS prix + port. Une carte à 0,99 $ avec 4,50 $
 * de port n'est pas une carte à 0,99 $, et comparer des prix hors port fausse
 * toute la grille.
 */
const HOST = { production: 'https://api.ebay.com', sandbox: 'https://api.sandbox.ebay.com' };
const TIMEOUT_MS = 20_000;

/**
 * Catégorie « Pokémon Individual Cards ». À VÉRIFIER dans le Seller Hub avant
 * de s'y fier : une mauvaise catégorie ramène des lots et des accessoires, ce
 * qui pollue la moyenne bien plus sûrement qu'un mauvais mot-clé.
 */
export const EBAY_CATEGORY_POKEMON_SINGLES = '183454';

export interface EbayEnv {
  clientId: string;
  clientSecret: string;
  env: 'production' | 'sandbox';
  marketplaceId?: string;
}

/** Une observation : un total, et une date quand elle existe. */
export interface Observation {
  /** Prix + port, en cents. C'est le seul chiffre comparable. */
  totalCents: number;
  priceCents: number;
  shippingCents: number;
  /** ISO. Renseignée pour les ventes passées, absente pour les annonces actives. */
  soldAt?: string;
  title: string;
  itemId: string;
}

export interface CompsSummary {
  /** Moyenne des totaux, en cents. C'est ce que tu as demandé à voir. */
  averageCents: number | null;
  /**
   * Médiane des totaux, en cents. C'est ce que le moteur de prix utilise : une
   * annonce délirante à 200 $ sur une carte à 3 $ déplace la moyenne et pas la
   * médiane (docs/03 §2). Les deux sont affichées, pour que l'écart entre elles
   * soit lui-même un signal.
   */
  medianCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  count: number;
  observations: Observation[];
}

export class EbayUnavailable extends Error {
  override readonly name = 'EbayUnavailable';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Accès refusé faute de whitelisting — distinct d'une panne. */
export class EbayNotEntitled extends Error {
  override readonly name = 'EbayNotEntitled';
}

// ---------------------------------------------------------------------------
// OAuth applicatif
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;

/**
 * Jeton applicatif (client_credentials). Aucun utilisateur impliqué : ces API
 * lisent des données publiques.
 *
 * Le jeton est mis en cache jusqu'à une minute avant expiration — en redemander
 * un à chaque carte brûlerait le quota pour rien.
 */
export async function getAppToken(cfg: EbayEnv): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(`${HOST[cfg.env]}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    // Jamais le secret dans le message : docs/05 §4.
    throw new EbayUnavailable(
      `jeton eBay refusé (${res.status}) : ${body.slice(0, 200)}`,
      res.status,
    );
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

/** Réservé aux tests. */
export function resetTokenCache(): void {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Agrégation — fonctions pures, testables sans réseau
// ---------------------------------------------------------------------------

function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function summarize(observations: readonly Observation[]): CompsSummary {
  if (observations.length === 0) {
    return {
      averageCents: null,
      medianCents: null,
      lowCents: null,
      highCents: null,
      count: 0,
      observations: [],
    };
  }

  const totals = observations.map((o) => o.totalCents).sort((a, b) => a - b);
  const sum = totals.reduce((s, v) => s + v, 0);
  const mid = totals.length >> 1;

  return {
    averageCents: Math.round(sum / totals.length),
    medianCents:
      totals.length % 2 === 0
        ? Math.round(((totals[mid - 1] as number) + (totals[mid] as number)) / 2)
        : (totals[mid] as number),
    lowCents: totals[0] as number,
    highCents: totals[totals.length - 1] as number,
    count: totals.length,
    observations: [...observations],
  };
}

/**
 * Requête mot-clé pour une carte.
 *
 * Le numéro est le discriminant le plus fiable — bien plus que le nom, qui est
 * partagé par des dizaines de rééditions. On le met donc dans la requête.
 *
 * Ça reste une recherche PLEIN TEXTE : elle ramènera du bruit (lots, proxies,
 * cartes gradées). C'est pourquoi la médiane est calculée à côté de la moyenne.
 */
export function buildQuery(name: string, number: string, printedTotal: number | null): string {
  const denom = printedTotal === null ? '' : `/${printedTotal}`;
  return `${name} ${number}${denom}`.trim();
}

// ---------------------------------------------------------------------------
// Annonces actives — Browse API
// ---------------------------------------------------------------------------

interface BrowseItem {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  shippingOptions?: { shippingCost?: { value?: string; currency?: string } }[];
}

/**
 * Moyenne prix + port des annonces ACTIVES.
 *
 * `shippingOptions` absent ou vide se lit comme « port non communiqué », pas
 * comme « gratuit » : on écarte l'annonce plutôt que de la compter à zéro et de
 * tirer la moyenne vers le bas.
 */
export async function fetchActiveListings(
  cfg: EbayEnv,
  query: string,
  limit = 50,
): Promise<CompsSummary> {
  const token = await getAppToken(cfg);
  const params = new URLSearchParams({
    q: query,
    category_ids: EBAY_CATEGORY_POKEMON_SINGLES,
    filter: 'buyingOptions:{FIXED_PRICE}',
    limit: String(limit),
  });

  const res = await fetch(`${HOST[cfg.env]}/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': cfg.marketplaceId ?? 'EBAY_US',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 429 || res.status >= 500) {
    throw new EbayUnavailable(`Browse API ${res.status}`, res.status);
  }
  if (!res.ok) {
    throw new EbayUnavailable(`Browse API ${res.status}`, res.status);
  }

  const body = (await res.json()) as { itemSummaries?: BrowseItem[] };
  const observations: Observation[] = [];

  for (const item of body.itemSummaries ?? []) {
    const priceCents = toCents(item.price?.value);
    if (priceCents === null) continue;

    const shipRaw = item.shippingOptions?.[0]?.shippingCost?.value;
    const shippingCents = toCents(shipRaw);
    // Port inconnu : on écarte plutôt que de supposer la gratuité.
    if (shippingCents === null) continue;

    observations.push({
      totalCents: priceCents + shippingCents,
      priceCents,
      shippingCents,
      title: item.title ?? '',
      itemId: item.itemId ?? '',
    });
  }

  log.debug('annonces actives récupérées', { query, retenues: observations.length });
  return summarize(observations);
}

// ---------------------------------------------------------------------------
// Ventes passées — Marketplace Insights
// ---------------------------------------------------------------------------

interface InsightsSale {
  itemId?: string;
  title?: string;
  lastSoldPrice?: { value?: string; currency?: string };
  lastSoldDate?: string;
  shippingOptions?: { shippingCost?: { value?: string; currency?: string } }[];
}

/** Fenêtre couverte par Marketplace Insights. */
export const SOLD_WINDOW_DAYS = 90;

/**
 * Moyenne prix + port des VENTES PASSÉES, avec leurs dates.
 *
 * Nécessite le scope `buy.marketplace.insights`, en Limited Release : eBay le
 * réserve aux gros partenaires. Un 403 signifie « pas whitelisté », pas
 * « panne » — on lève `EbayNotEntitled` pour que l'appelant se rabatte sur la
 * source tierce sans retenter en boucle.
 */
export async function fetchSoldListings(
  cfg: EbayEnv,
  query: string,
  limit = 50,
): Promise<CompsSummary> {
  const token = await getAppToken(cfg);
  const params = new URLSearchParams({
    q: query,
    category_ids: EBAY_CATEGORY_POKEMON_SINGLES,
    filter: `lastSoldDate:[${new Date(Date.now() - SOLD_WINDOW_DAYS * 86_400_000).toISOString()}..]`,
    limit: String(limit),
  });

  const res = await fetch(
    `${HOST[cfg.env]}/buy/marketplace_insights/v1_beta/item_sales/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': cfg.marketplaceId ?? 'EBAY_US',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (res.status === 403 || res.status === 401) {
    throw new EbayNotEntitled(
      'Marketplace Insights refusé : scope buy.marketplace.insights non accordé. ' +
        'C’est une Limited Release réservée aux partenaires — voir docs/03 §1.',
    );
  }
  if (!res.ok) {
    throw new EbayUnavailable(`Marketplace Insights ${res.status}`, res.status);
  }

  const body = (await res.json()) as { itemSales?: InsightsSale[] };
  const observations: Observation[] = [];

  for (const sale of body.itemSales ?? []) {
    const priceCents = toCents(sale.lastSoldPrice?.value);
    if (priceCents === null) continue;

    // Sur une vente passée, un port absent est fréquent et souvent réellement
    // gratuit. On le compte à zéro mais on le trace, pour pouvoir distinguer
    // plus tard « gratuit » de « inconnu ».
    const shippingCents = toCents(sale.shippingOptions?.[0]?.shippingCost?.value) ?? 0;

    observations.push({
      totalCents: priceCents + shippingCents,
      priceCents,
      shippingCents,
      ...(sale.lastSoldDate ? { soldAt: sale.lastSoldDate } : {}),
      title: sale.title ?? '',
      itemId: sale.itemId ?? '',
    });
  }

  log.debug('ventes passées récupérées', { query, retenues: observations.length });
  return summarize(observations);
}

/** Config eBay depuis l'environnement, ou null si non configurée. */
export function ebayEnvFromProcess(): EbayEnv | null {
  const clientId = process.env['EBAY_CLIENT_ID'];
  const clientSecret = process.env['EBAY_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    env: process.env['EBAY_ENV'] === 'production' ? 'production' : 'sandbox',
    ...(process.env['EBAY_MARKETPLACE_ID']
      ? { marketplaceId: process.env['EBAY_MARKETPLACE_ID'] }
      : {}),
  };
}
