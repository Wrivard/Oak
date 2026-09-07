import { THRESHOLDS } from '../../lib/config/thresholds.js';
import { FEES } from '../../lib/config/fees.js';
import { loadConfig } from '../pricing/queries.js';
import type { PricingConfig } from '../../lib/pricing/rules.js';
import { loadReviewQueue, OPTIONS } from './queries.js';
import ReviewClient from './review-client.js';

/**
 * Niveau 3 de résolution. Voir docs/06-ui.md.
 *
 * Toujours rendue à la demande : la file bouge en continu pendant qu'un scan
 * tourne, et une page mise en cache montrerait un état périmé.
 */
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Review' };

/**
 * Le seuil « une carte chère se regarde » existait DEUX fois : ici, en dur dans
 * `lib/config/thresholds.ts`, et dans `pricing_rules.config.review_threshold`
 * que l'écran des prix rend éditable. Le même nombre, la même idée, deux
 * sources — éditer le champ ne changeait que le drapeau de publication, et la
 * review continuait de colorer selon l'ancienne valeur.
 *
 * La config en base gagne, parce que c'est celle qu'on peut changer sans
 * redéployer. La constante reste le repli quand la config est illisible : la
 * review doit s'afficher même avec une configuration de prix cassée.
 */
async function seuilCarteChere(): Promise<number> {
  try {
    return (await loadConfig()).review_threshold;
  } catch {
    return THRESHOLDS.hardReview.minValue;
  }
}

/**
 * La configuration de prix, ou `null` si elle est illisible.
 *
 * Elle sert à montrer ce que vaudrait la carte dans chaque condition. La review
 * doit s'afficher même avec une configuration de prix cassée : on perd
 * l'échelle, pas l'écran.
 */
async function reglesDePrix(): Promise<PricingConfig | null> {
  try {
    return await loadConfig();
  } catch {
    return null;
  }
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const brut = sp['lot'];
  const lot = (Array.isArray(brut) ? brut[0] : brut)?.trim();

  const [scans, hardReviewMin, regles] = await Promise.all([
    loadReviewQueue(200, lot),
    seuilCarteChere(),
    reglesDePrix(),
  ]);

  return (
    <ReviewClient
      scans={scans}
      thresholds={{
        // Pas d'équivalent en base pour celui-ci : il gouverne la publication
        // automatique de l'étape 9, pas encore écrite.
        autoAcceptMax: THRESHOLDS.autoAccept.maxValue,
        hardReviewMin,
      }}
      variants={OPTIONS.variants}
      conditions={OPTIONS.conditions}
      feesVerified={FEES.verified}
      lot={lot === undefined || lot === '' ? null : lot}
      regles={regles}
      shippingCents={FEES.shippingCents}
    />
  );
}
