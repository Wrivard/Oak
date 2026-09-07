import Link from 'next/link';
import AutoRefresh from './shell/auto-refresh.js';
import { loadTaches } from './accueil/queries.js';

/**
 * « Qu'est-ce que j'ai à faire. »
 *
 * Cette page redirigeait vers l'envoi de photos, avec pour raison qu'« il n'y a
 * pas d'accueil à faire lire ». C'était juste tant que l'application n'avait
 * qu'un flux : scanner, puis trier. Depuis, il y a des lots à fermer, des SKUs
 * sans prix, des résolutions automatiques à contrôler — et rien qui les
 * rassemble. On finissait par ouvrir les sept écrans un par un pour savoir
 * lequel demandait quelque chose.
 *
 * Ce n'est toujours pas un accueil à LIRE : c'est une liste de tâches avec un
 * compte et une destination, et elle disparaît quand il n'y a rien à faire.
 *
 * À ne pas confondre avec le tableau de santé, qui répond à « est-ce que la
 * machine tourne ». Une machine parfaitement saine peut avoir cent cartes en
 * attente : rien n'est en panne, et pourtant rien n'avance.
 */
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Aujourd’hui' };

export default async function Accueil() {
  const taches = await loadTaches();

  return (
    <>
      <AutoRefresh seconds={20} />
      <header className="page-head">
        <h1 className="page-title">Aujourd’hui</h1>
        <span className="page-sub">
          {taches.length === 0
            ? 'rien en attente'
            : `${taches.length} chose${taches.length > 1 ? 's' : ''} à faire`}
        </span>
        <div className="page-actions">
          <Link href="/upload" className="btn btn--primary">
            Envoyer un lot
          </Link>
        </div>
      </header>

      <div className="page-body">
        <div className="narrow">
          {taches.length === 0 ? (
            <div className="empty" style={{ height: 300 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Rien n’attend</div>
              <div className="dim" style={{ maxWidth: 420, textAlign: 'center' }}>
                Tout ce qui est entré a été trié, tous les lots sont fermés, tout ce
                qui est en stock a un prix. Le prochain geste est de scanner.
              </div>
              <Link href="/upload" className="btn btn--primary" style={{ marginTop: 'var(--s2)' }}>
                Envoyer un lot
              </Link>
            </div>
          ) : (
            <div className="taches">
              {taches.map((t) => (
                <Link key={t.cle} href={t.lien} className="tache" data-ton={t.ton}>
                  {/* Le CHIFFRE d'abord, en gros, à gauche : c'est lui qui dit
                      si la tâche vaut le coup d'être commencée maintenant. Le
                      titre explique, le détail justifie. */}
                  <span className="tache-compte">
                    {t.compte > 0 ? (
                      <>
                        <span className="num">{t.compte.toLocaleString('fr')}</span>
                        <span className="tache-unite">
                          {t.unite}
                          {t.compte > 1 && t.unite !== '' ? 's' : ''}
                        </span>
                      </>
                    ) : (
                      <span className="tache-bang">!</span>
                    )}
                  </span>
                  <span className="tache-texte">
                    <span className="tache-titre">{t.titre}</span>
                    <span className="tache-detail">{t.detail}</span>
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="tache-fleche"
                    aria-hidden
                  >
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
