import { THRESHOLDS } from '../../lib/config/thresholds.js';
import { FEES } from '../../lib/config/fees.js';
import { loadReviewQueue, OPTIONS } from './queries.js';
import ReviewClient from './review-client.js';

/**
 * Niveau 3 de résolution. Voir docs/06-ui.md.
 *
 * Toujours rendue à la demande : la file bouge en continu pendant qu'un scan
 * tourne, et une page mise en cache montrerait un état périmé.
 */
export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const scans = await loadReviewQueue();

  return (
    <ReviewClient
      scans={scans}
      thresholds={{
        autoAcceptMax: THRESHOLDS.autoAccept.maxValue,
        hardReviewMin: THRESHOLDS.hardReview.minValue,
      }}
      variants={OPTIONS.variants}
      conditions={OPTIONS.conditions}
      feesVerified={FEES.verified}
    />
  );
}
