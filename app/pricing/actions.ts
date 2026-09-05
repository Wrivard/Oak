'use server';

import { revalidatePath } from 'next/cache';
import { query } from '../../lib/db.js';
import { log } from '../../lib/log.js';
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
    revalidatePath('/pricing');
    return { ok: true };
  } catch (err) {
    log.warn('config de prix rejetée', { err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
