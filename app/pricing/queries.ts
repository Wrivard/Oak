import { query } from '../../lib/db.js';
import { parsePricingConfig, type PricingConfig } from '../../lib/pricing/rules.js';
import type { CardCondition } from '../../lib/sku.js';

/**
 * Données de l'éditeur de règles. Lecture seule, côté serveur.
 */
export interface PreviewSku {
  sku: string;
  name: string;
  set_name: string;
  condition: CardCondition;
  /** Valeur estimée en cents, null si le SKU n'a pas encore de prix mesuré. */
  valueCents: number | null;
  currentCents: number | null;
}

export async function loadConfig(): Promise<PricingConfig> {
  const { rows } = await query<{ config: unknown }>(
    'select config from pricing_rules where id = 1',
  );
  return parsePricingConfig(rows[0]?.config);
}

/**
 * Vingt SKUs réels pour la preview, étalés sur la plage de valeurs plutôt que
 * pris au hasard : une preview qui ne montre que du bulk ne dit rien des bandes
 * hautes, et c'est là que les erreurs coûtent.
 */
export async function loadPreviewSkus(): Promise<PreviewSku[]> {
  const { rows } = await query<{
    sku: string;
    name: string;
    set_name: string;
    condition: CardCondition;
    value_estimate: string | null;
    current_price: string | null;
  }>(
    `with ranked as (
       select i.sku, c.name, c.set_name, i.condition,
              i.value_estimate::text, i.current_price::text,
              ntile(20) over (order by i.value_estimate nulls last) as bucket,
              row_number() over (
                partition by ntile(20) over (order by i.value_estimate nulls last)
                order by i.sku
              ) as rn
         from inventory i join cards c on c.id = i.card_id
        where i.qty_on_hand > 0
     )
     select sku, name, set_name, condition, value_estimate, current_price
       from ranked where rn = 1 order by value_estimate nulls last limit 20`,
  );

  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    set_name: r.set_name,
    condition: r.condition,
    valueCents: r.value_estimate === null ? null : Math.round(Number(r.value_estimate) * 100),
    currentCents: r.current_price === null ? null : Math.round(Number(r.current_price) * 100),
  }));
}

/**
 * Échelle de valeurs de repli quand l'inventaire est vide.
 *
 * Elle reprend les lignes du tableau de docs/03 §3 plus les frontières de
 * bandes : c'est ce qu'on veut voir bouger quand on édite une bande. Étiquetée
 * comme synthétique dans l'UI — on ne fait jamais passer ça pour du réel.
 */
export const FALLBACK_LADDER: readonly number[] = [
  50, 175, 190, 200, 201, 300, 500, 501, 1000, 2000, 2001, 2500, 5000, 7500, 7501,
  12000, 25000,
];
