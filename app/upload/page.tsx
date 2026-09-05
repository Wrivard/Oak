import { OPTIONS } from '../review/queries.js';
import UploadClient from './upload-client.js';

/**
 * Point d'entrée du pipeline quand les photos viennent d'une autre application
 * plutôt que d'un dossier surveillé.
 */
export const dynamic = 'force-dynamic';

export default function UploadPage() {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <UploadClient
      variants={OPTIONS.variants}
      conditions={OPTIONS.conditions}
      defaultSession={`lot-${today}`}
    />
  );
}
