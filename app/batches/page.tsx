import Link from 'next/link';
import AutoRefresh from '../shell/auto-refresh.js';
import BatchActions from './batch-row.js';
import { loadAnomalies, loadBatches, type Batch } from './queries.js';
import { formatCents } from '../../lib/pricing/net.js';

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
        {b.resolved} résolues ·{' '}
        {/* Le chemin le plus court entre « ce lot a 18 cartes en review » et
            « je les traite » : sans ce lien il fallait ouvrir la review, la
            trouver dans une file mélangée, et se rappeler où on en était. */}
        {b.review > 0 ? (
          <Link href={`/review?lot=${encodeURIComponent(b.name)}`} title={`Reviewer ${b.name}`}>
            {b.review} en review
          </Link>
        ) : (
          <>{b.review} en review</>
        )}
        {b.rejected > 0 && ` · ${b.rejected} écartées`}
        {b.pending > 0 && ` · ${b.pending} en cours`}
      </div>
    </div>
  );
}

export default async function BatchesPage() {
  const [batches, anomalies] = await Promise.all([loadBatches(40, true), loadAnomalies()]);

  const totalCards = batches.reduce(
    (s, b) => s + b.resolved + b.review + b.pending + b.rejected,
    0,
  );
  // La bande de chiffres de l'en-tête. Ce qu'on veut savoir en arrivant :
  // combien de lots, combien de cartes, combien de travail humain reste, et ce
  // que tout ça vaut. Quatre nombres, pas une phrase.
  const totalReview = batches.reduce((s, b) => s + b.review, 0);
  const totalValeur = batches.reduce((s, b) => s + (b.valeurCents ?? 0), 0);

  return (
    <>
      <AutoRefresh seconds={10} />
      <header className="page-head">
        <h1 className="page-title">Lots</h1>
        <span className="page-sub">
          {batches.length} lot{batches.length > 1 ? 's' : ''} ·{' '}
          {totalCards.toLocaleString('fr')} cartes
          {totalReview > 0 && (
            <>
              {' · '}
              <Link href="/review" style={{ color: 'var(--amber)' }}>
                {totalReview.toLocaleString('fr')} en review
              </Link>
            </>
          )}
          {totalValeur > 0 && ` · ${formatCents(totalValeur)}`}
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
          /*
            UNE GRILLE DE CARTES, pas un tableau.

            Un tableau range des colonnes comparables. Un lot n'est pas une
            ligne de chiffres : c'est une pile physique qu'on a posée sur le
            scanner, et ce qu'on veut en savoir d'abord — qu'est-ce qu'il y a
            dedans, combien ça vaut, qu'est-ce qu'il reste à faire — ne se lit
            pas en balayant sept colonnes. La carte la plus chère du lot en
            vignette dit en une image ce qu'aucun nom de lot ne dira.
          */
          <div className="lots-grille">
            {batches.map((b) => {
              const total = b.resolved + b.review + b.pending + b.rejected;
              const ecart =
                b.expected !== null && b.expected !== b.scanned ? b.scanned - b.expected : 0;

              return (
                <article key={b.id} className="lot">
                  <div className="lot-vignette">
                    {b.image !== null ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={b.image} alt="" loading="lazy" />
                    ) : (
                      /* Une silhouette de carte plutôt qu'un rectangle vide :
                         la grille garde son rythme, et le message dit ce qui
                         manque au lieu de laisser un trou. */
                      <span className="lot-vignette-vide">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                          <rect x="6" y="3" width="12" height="18" rx="2" />
                          <path d="M9 9h6M9 13h4" strokeLinecap="round" />
                        </svg>
                        {total === 0 ? 'aucune carte' : 'rien de résolu'}
                      </span>
                    )}
                    <span className={`lot-etat lot-etat--${b.status === 'open' ? 'ouvert' : 'clos'}`}>
                      {b.status === 'open' ? 'ouvert' : 'fermé'}
                    </span>
                  </div>

                  <div className="lot-corps">
                    <div>
                      <div className="lot-nom tronque">{b.name}</div>
                      <div className="faint tronque" style={{ fontSize: 11 }}>
                        {b.openedAt} · {b.variant} · {b.condition} · {b.lane}
                      </div>
                    </div>

                    <Progress b={b} />

                    <div className="lot-chiffres">
                      <span className="num">
                        {b.valeurCents === null || b.valeurCents === 0 ? (
                          <span className="faint">—</span>
                        ) : (
                          formatCents(b.valeurCents)
                        )}
                      </span>
                      {/* L'écart de comptage passe AVANT tout le reste : c'est
                          le seul signal d'une carte physique perdue. */}
                      {ecart !== 0 ? (
                        <span className="num" style={{ color: 'var(--red)' }}>
                          {ecart > 0 ? '+' : ''}
                          {ecart} de comptage
                        </span>
                      ) : (
                        <span className="mono faint" style={{ fontSize: 11 }}>
                          {b.ownHistory > 0 && `${b.ownHistory} empreinte`}
                          {b.ownHistory > 0 && b.catalog > 0 && ' · '}
                          {b.catalog > 0 && `${b.catalog} catalogue`}
                          {b.manual > 0 && ` · ${b.manual} manuel`}
                        </span>
                      )}
                    </div>

                    <div className="lot-actions">
                      <BatchActions batch={b} />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        </div>
      </div>
    </>
  );
}
