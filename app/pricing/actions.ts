'use server';

import { query } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import { revalidateQuietly } from '../revalidate.js';
import { parsePricingConfig } from '../../lib/pricing/rules.js';

/**
 * Écriture de `pricing_rules.config`. Voir docs/03-pricing.md §3.
 *
 * La config est éditable sans redeploy, mais jamais sans validation : elle pilote
 * le prix de 12-15k SKUs, et une config malformée qui passerait produirait des
 * prix nuls en silence sur tout l'inventaire.
 */
export interface SaveResult {
  ok: boolean;
  error?: string;
}

export async function savePricingConfig(json: string): Promise<SaveResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `JSON invalide : ${String(err)}` };
  }

  try {
    // Valide AVANT d'écrire. Le schéma refuse notamment une dernière bande
    // plafonnée, qui laisserait les cartes chères sans bande.
    const cfg = parsePricingConfig(raw);

    await query(
      `update pricing_rules set config = $1, updated_at = now() where id = 1`,
      [cfg],
    );

    log.info('règles de prix mises à jour', {
      hard_floor: cfg.hard_floor,
      bandes: cfg.bands.length,
    });

    // Hors du try qui décide du succès : une revalidation ratée ferait croire
    // que la config n'a pas été enregistrée alors qu'elle l'est, et on la
    // réenregistrerait en boucle.
    revalidateQuietly('/pricing');
    return { ok: true };
  } catch (err) {
    log.warn('config de prix rejetée', { err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Déclenche un rafraîchissement des prix maintenant.
 *
 * Le cron le fait toutes les heures sur 500 SKUs. Après avoir changé une règle,
 * attendre l'heure suivante pour voir l'effet sur de vraies cartes n'est pas
 * tenable — et la seule alternative documentée était d'ouvrir psql pour insérer
 * un job à la main, ce qui n'est pas une interface.
 *
 * ON ENFILE UN JOB, on ne price pas ici. Invariant 4 de CLAUDE.md : aucun appel
 * API externe dans une requête HTTP. Un batch de 500 SKUs contre pokemontcg.io
 * dépasserait de toute façon largement le temps d'une requête.
 *
 * La clé d'idempotence est à la minute : cliquer trois fois de suite n'enfile
 * qu'un seul batch, ce qui évite de brûler le quota de l'API par impatience.
 */
export interface RefreshResult {
  ok: boolean;
  /** false si un batch de cette minute était déjà en file. */
  enfile?: boolean;
  error?: string;
}

export async function triggerPriceRefresh(limit = 200): Promise<RefreshResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    return { ok: false, error: 'limite invalide' };
  }

  try {
    const minute = new Date().toISOString().slice(0, 16);
    const { rows } = await query<{ id: string }>(
      `insert into jobs (type, payload, idempotency_key, priority)
       values ('price_refresh', $1, $2, 10)
       on conflict (idempotency_key) do nothing
       returning id::text`,
      [{ limit }, `price_refresh:manuel:${minute}`],
    );

    const enfile = rows.length > 0;
    log.info('rafraîchissement des prix demandé à la main', { limit, enfile });
    return { ok: true, enfile };
  } catch (err) {
    log.error('impossible d’enfiler le rafraîchissement', { err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
