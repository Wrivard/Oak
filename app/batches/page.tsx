import Link from 'next/link';
import AutoRefresh from '../shell/auto-refresh.js';
import BatchActions from './batch-row.js';
import { loadAnomalies, loadBatches, type Batch } from './queries.js';

/**
 * Suivi des lots envoyés. Rendue à la demande et rafraîchie : c'est l'écran
 * qu'on laisse ouvert pendant que le worker draine un lot.
 */
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Lots' };

function Progress({ b }: { b: Batch }) {
  // Les écartées comptent dans le total : sans elles, un lot contenant des
  // intercalaires afficherait une barre qui ne se remplit jamais.
  const total = b.pending + b.review + b.resolved + b.rejected;
  if (total === 0) return <span className="faint">—</span>;

  const pct = (n: number) => `${(100 * n) / total}%`;

  return (
    <div style={{ minWidth: 160 }}>
      {/* Trois segments plutôt qu'un pourcentage : ce qui compte n'est pas
          « combien c'est avancé » mais « combien va coûter du temps humain ». */}
      <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', background: 'var(--surface-3)' }}>
        <span style={{ width: pct(b.resolved), background: 'var(--green)' }} />
        <span style={{ width: pct(b.review), background: 'var(--amber)' }} />
        <span style={{ width: pct(b.rejected), background: 'var(--text-faint)' }} />
        <span style={{ width: pct(b.pending), background: 'var(--border-lit)' }} />
      </div>
      {/* Sur une seule ligne : ce détail passait sur deux dans une fenêtre
          étroite et déséquilibrait la hauteur des lignes du tableau. */}
      <div className="mono faint" style={{ fontSize: 11, marginTop: 3, whiteSpace: 'nowrap' }}>
        {b.resolved} résolues · {b.review} en review
        {b.rejected > 0 && ` · ${b.rejected} écartées`}
        {b.pending > 0 && ` · ${b.pending} en cours`}
      </div>
    </div>
  );
}

export default async function BatchesPage() {
  const [batches, anomalies] = await Promise.all([loadBatches(), loadAnomalies()]);

  const totalCards = batches.reduce(
    (s, b) => s + b.resolved + b.review + b.pending + b.rejected,
    0,
  );

  return (
    <>
      <AutoRefresh seconds={10} />
      <header className="page-head">
        <h1 className="page-title">Lots</h1>
        <span className="page-sub">
          {batches.length} lot{batches.length > 1 ? 's' : ''} ·{' '}
          {totalCards.toLocaleString('fr')} cartes
        </span>
        <div className="page-actions">
          <Link href="/upload" className="btn btn--primary">
            Envoyer un lot
          </Link>
        </div>
      </header>

      <div className="page-body">
        <div className="large">
        {anomalies.length > 0 && (
          <div className="note note--warn" style={{ marginBottom: 'var(--s4)' }}>
            <strong>
              {anomalies.length} anomalie{anomalies.length > 1 ? 's' : ''} d’appariement
            </strong>
            <ul style={{ margin: 'var(--s2) 0 0', paddingLeft: 'var(--s4)', fontSize: 12 }}>
              {anomalies.slice(0, 5).map((a, i) => (
                <li key={i}>
                  <span className="mono">{a.sessionName}</span> — {a.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {batches.length === 0 ? (
          <div className="empty" style={{ height: 260 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Aucun lot</div>
            <div className="dim">Commence par envoyer des photos.</div>
            <Link href="/upload" className="btn btn--primary" style={{ marginTop: 'var(--s2)' }}>
              Envoyer un lot
            </Link>
          </div>
        ) : (
          /* Le tableau vit DANS un cadre : posé à même le fond, il se lisait
             comme un document imprimé plutôt que comme un objet de
             l'application. */
          <div className="cadre">
          <table className="table">
            <thead>
              <tr>
                <th>Lot</th>
                <th style={{ textAlign: 'left' }}>Avancement</th>
                <th>Résolution</th>
                <th>Comptage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const ecart =
                  b.expected !== null && b.expected !== b.scanned
                    ? b.scanned - b.expected
                    : 0;

                return (
                  <tr key={b.id}>
                    {/* Largeur BORNÉE et texte coupé à l'ellipse. Sur une
                        fenêtre étroite, « 2026-09-06 05:14 · reverseHolofoil ·
                        NM · adf » passait sur trois lignes et cette ligne du
                        tableau devenait une fois et demie plus haute que ses
                        voisines. Un tableau qui ondule se relit à chaque coup
                        d'oeil. */}
                    <td style={{ maxWidth: 320 }}>
                      <div className="tronque" style={{ fontWeight: 500 }}>
                        {b.name}
                      </div>
                      <div
                        className="faint tronque"
                        style={{ fontSize: 11 }}
                        title={`${b.openedAt} · ${b.variant} · ${b.condition} · ${b.lane}`}
                      >
                        {b.openedAt} · {b.variant} · {b.condition} · {b.lane}
                      </div>
                    </td>
                    <td style={{ textAlign: 'left' }}>
                      <Progress b={b} />
                    </td>
                    <td className="mono faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      {b.ownHistory > 0 && <div>{b.ownHistory} empreinte</div>}
                      {b.catalog > 0 && <div>{b.catalog} catalogue</div>}
                      {b.manual > 0 && <div>{b.manual} manuel</div>}
                      {b.ownHistory + b.catalog + b.manual === 0 && <div>—</div>}
                    </td>
                    <td>
                      {/* L'écart de comptage est le pire bug possible parce
                          qu'il est silencieux : une carte physique sans ligne
                          d'inventaire. Voir docs/02 §1. */}
                      {ecart !== 0 ? (
                        <span style={{ color: 'var(--red)' }} className="num">
                          {ecart > 0 ? '+' : ''}
                          {ecart}
                        </span>
                      ) : (
                        <span className="mono faint">{b.scanned}</span>
                      )}
                    </td>
                    <td>
                      <BatchActions batch={b} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        </div>
      </div>
    </>
  );
}
