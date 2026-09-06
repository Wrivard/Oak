/**
 * Squelette pendant le rendu serveur.
 *
 * Sans lui, changer d'écran laisse la page précédente figée puis remplacée d'un
 * coup : on ne sait pas si l'application a compris le clic. Un squelette dit
 * « c'est en cours » sans faire clignoter le contenu.
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
        <div className="narrow" style={{ display: 'grid', gap: 'var(--s3)' }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="panel"
              style={{
                height: 64,
                // Une opacité dégressive suggère la profondeur de la liste sans
                // animation supplémentaire : docs/06 §1 interdit ce qui bouge
                // sous le curseur.
                opacity: 1 - i * 0.2,
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s3)',
              }}
            >
              <span className="squelette" style={{ width: 30, height: 30, borderRadius: 8 }} />
              <span style={{ display: 'grid', gap: 7, flex: 1 }}>
                <span className="squelette" style={{ width: `${52 - i * 7}%`, height: 11 }} />
                <span className="squelette" style={{ width: `${34 - i * 5}%`, height: 9, opacity: 0.6 }} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
