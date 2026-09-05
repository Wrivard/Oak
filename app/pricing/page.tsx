import { FEES } from '../../lib/config/fees.js';
import { FALLBACK_LADDER, loadConfig, loadPreviewSkus } from './queries.js';
import PricingClient from './pricing-client.js';

/**
 * Éditeur de règles de prix. Voir docs/03-pricing.md §3 et §4.
 *
 * Rendue à la demande : la config change et la preview doit refléter l'état réel.
 */
export const dynamic = 'force-dynamic';

/**
 * Coût d'expédition retenu pour la preview. Une enveloppe rembourrée avec suivi
 * tourne autour de 1 $ — c'est l'ordre de grandeur qui rend le net à 1,75 $
 * lisible. À remplacer par le coût réel mesuré quand il sera connu.
 */
const PREVIEW_SHIPPING_CENTS = 100;

export default async function PricingPage() {
  const [config, skus] = await Promise.all([loadConfig(), loadPreviewSkus()]);

  return (
    <PricingClient
      initialConfig={JSON.stringify(config, null, 2)}
      skus={skus}
      ladder={FALLBACK_LADDER}
      feesVerified={FEES.verified}
      shippingCents={PREVIEW_SHIPPING_CENTS}
    />
  );
}
