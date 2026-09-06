import Link from 'next/link';
import { OPTIONS } from '../review/queries.js';
import { loadBatches } from '../batches/queries.js';
import UploadClient from './upload-client.js';

/**
 * Point d'entrée du pipeline quand les photos viennent d'une autre application
 * plutôt que d'un dossier surveillé.
 */
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Envoyer' };

export default async function UploadPage() {
  const today = new Date().toISOString().slice(0, 10);
  // Les derniers lots, sous la carte d'envoi. Ce n'est pas du remplissage :
  // après avoir envoyé, la question suivante est TOUJOURS « et alors, qu'est-ce
  // qu'elles deviennent ». Les avoir là évite un aller-retour vers /batches à
  // chaque envoi, et l'écran cesse d'être une carte seule au milieu du vide.
  const derniers = await loadBatches(4);

  return (
    <UploadClient
      variants={OPTIONS.variants}
      conditions={OPTIONS.conditions}
      defaultSession={`lot-${today}`}
      derniers={derniers.map((b) => ({
        id: b.id,
        name: b.name,
        openedAt: b.openedAt,
        status: b.status,
        resolved: b.resolved,
        review: b.review,
        pending: b.pending,
        rejected: b.rejected,
      }))}
      lienLots={<Link href="/batches" className="btn btn--ghost btn--sm">Tous les lots</Link>}
    />
  );
}
