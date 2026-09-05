import Link from 'next/link';
import AuditClient from './audit-client.js';
import { loadAudit } from './queries.js';

/**
 * Vérifier ce que la machine a décidé seule.
 *
 * Sans cet écran, on fait confiance à l'aveugle — et l'erreur ne se découvre
 * qu'à la commande qu'on ne peut pas honorer.
 */
export const dynamic = 'force-dynamic';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp['source']) ? sp['source'][0] : sp['source'];
  const source = raw === 'catalog' || raw === 'own_history' ? raw : undefined;

  const rows = await loadAudit(60, source);

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Vérifier</h1>
        <span className="page-sub">
          {rows.length} résolution{rows.length > 1 ? 's' : ''} automatique
          {rows.length > 1 ? 's' : ''} récente{rows.length > 1 ? 's' : ''}
        </span>
        <div className="page-actions">
          <Link href="/audit" className={`btn${source === undefined ? ' btn--primary' : ''}`}>
            Toutes
          </Link>
          <Link
            href="/audit?source=catalog"
            className={`btn${source === 'catalog' ? ' btn--primary' : ''}`}
          >
            Catalogue
          </Link>
          <Link
            href="/audit?source=own_history"
            className={`btn${source === 'own_history' ? ' btn--primary' : ''}`}
          >
            Empreinte
          </Link>
        </div>
      </header>

      <AuditClient rows={rows} />
    </>
  );
}
