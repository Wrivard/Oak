/**
 * Squelette pendant le rendu serveur.
 *
 * Sans lui, changer d'écran laisse la page précédente figée puis remplacée d'un
 * coup : on ne sait pas si l'application a compris le clic. Un squelette dit
 * « c'est en cours » sans faire clignoter le contenu.
 *
 * Il a la FORME de ce qui arrive. L'ancien dessinait quatre cartes dans une
 * colonne étroite, alors que cinq des sept écrans sont un tableau pleine
 * largeur : l'attente se terminait par un saut de mise en page, ce qui est
 * exactement l'inverse de l'effet recherché. Un cadre, une bande d'en-tête, des
 * lignes régulières — la page arrive à la place de son propre gabarit.
 *
 * Le balayage est LENT et FAIBLE — 1,4 s, 6 % d'opacité. Un squelette qui
 * scintille attire l'oeil sur l'attente au lieu de la rendre supportable, et on
 * finit par regarder le chargement plutôt que d'attendre le contenu.
 */
export default function Loading() {
  return (
    <>
      <header className="page-head">
        <span className="squelette" style={{ width: 132, height: 14 }} />
        <span className="squelette" style={{ width: 88, height: 11, opacity: 0.6 }} />
      </header>

      <div className="page-body">
        <div className="large">
          <div className="cadre">
            {/* La bande d'en-tête : c'est elle qui donne au bloc sa silhouette
                de tableau avant même qu'une ligne existe. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s5)',
                height: 33,
                padding: '0 var(--s4)',
                background: 'var(--surface-2)',
                borderBottom: '1px solid var(--border-lit)',
              }}
            >
              {[70, 96, 62, 54].map((w) => (
                <span key={w} className="squelette" style={{ width: w, height: 8 }} />
              ))}
            </div>

            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s5)',
                  height: 41,
                  padding: '0 var(--s4)',
                  borderBottom: i === 6 ? 'none' : '1px solid var(--border)',
                  // Une opacité dégressive suggère la profondeur de la liste
                  // sans animation supplémentaire : docs/06 §1 interdit ce qui
                  // bouge sous le curseur.
                  opacity: 1 - i * 0.11,
                }}
              >
                <span className="squelette" style={{ width: `${26 - (i % 3) * 4}%`, height: 10 }} />
                <span className="squelette" style={{ width: 104, height: 10, opacity: 0.6 }} />
                <span
                  className="squelette"
                  style={{ width: 58, height: 10, opacity: 0.6, marginLeft: 'auto' }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
