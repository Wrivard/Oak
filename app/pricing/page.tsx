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
 * Coût d'expédition retenu pour la preview.
 *
 * Il vient de `lib/config/fees.ts`, pas d'une constante locale : la review
 * affichait un net calculé avec ZÉRO port pendant que cet écran en comptait un
 * dollar. Sur une carte à 1,75 $, 1,11 $ contre 0,12 $ — deux conclusions
 * opposées sur la seule question qui compte à ce niveau de prix.
 */
const PREVIEW_SHIPPING_CENTS = FEES.shippingCents;

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
