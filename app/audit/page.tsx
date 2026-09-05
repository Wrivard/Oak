import Link from 'next/link';
import AuditClient from './audit-client.js';
import { AUDIT_PAGE_SIZE, loadAudit, type AuditSort } from './queries.js';

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
  const un = (k: string): string | undefined =>
    Array.isArray(sp[k]) ? sp[k][0] : (sp[k] as string | undefined);

  const raw = un('source');
  const source = raw === 'catalog' || raw === 'own_history' ? raw : undefined;
  const sort: AuditSort = un('sort') === 'doubtful' ? 'doubtful' : 'recent';
  const page = Math.max(1, Number(un('page') ?? 1) || 1);

  const data = await loadAudit({
    page,
    sort,
    ...(source === undefined ? {} : { source }),
  });
  const rows = data.rows;

  /** Conserve les filtres en changeant un seul paramètre. */
  const lien = (patch: Record<string, string | undefined>): string => {
    const u = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      ...(source ? { source } : {}),
      ...(sort === 'doubtful' ? { sort } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
      ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v !== undefined) u.set(k, v);
    const q = u.toString();
    return q === '' ? '/audit' : `/audit?${q}`;
  };

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Vérifier</h1>
        <span className="page-sub">
          {data.total.toLocaleString('fr')} résolution
          {data.total > 1 ? 's' : ''} automatique{data.total > 1 ? 's' : ''}
          {data.pages > 1 && ` · page ${data.page} / ${data.pages}`}
        </span>
        <div className="page-actions">
          <Link href={lien({ source: undefined, page: undefined })}
                className={`btn${source === undefined ? ' btn--primary' : ''}`}>
            Toutes
          </Link>
          <Link href={lien({ source: 'catalog', page: undefined })}
                className={`btn${source === 'catalog' ? ' btn--primary' : ''}`}>
            Catalogue
          </Link>
          <Link href={lien({ source: 'own_history', page: undefined })}
                className={`btn${source === 'own_history' ? ' btn--primary' : ''}`}>
            Empreinte
          </Link>
          {/* Regarder les soixante plus RÉCENTES sur les huit cents d'une
              journée, c'est regarder 7 % du lot au hasard. Les soixante MOINS
              SÛRES, ce sont celles où la machine a le plus de chances de s'être
              trompée. */}
          <Link
            href={lien({ sort: sort === 'doubtful' ? undefined : 'doubtful', page: undefined })}
            className={`btn${sort === 'doubtful' ? ' btn--primary' : ''}`}
            title="Les résolutions les moins sûres d’abord — la confiance de l’empreinte et celle du catalogue ne sont pas sur la même échelle, ce tri est le plus utile avec un filtre de source"
          >
            Moins sûres
          </Link>
        </div>
      </header>

      <AuditClient rows={rows} />

      {data.pages > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--s3)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--s4)',
          }}
        >
          {data.page > 1 ? (
            <Link href={lien({ page: String(data.page - 1) })} className="btn">
              Précédentes
            </Link>
          ) : (
            <span />
          )}
          <span className="faint mono" style={{ fontSize: 12 }}>
            page {data.page} / {data.pages} · {AUDIT_PAGE_SIZE} par page
          </span>
          {data.page < data.pages ? (
            <Link href={lien({ page: String(data.page + 1) })} className="btn">
              Suivantes
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </>
  );
}
