/**
 * Squelette pendant le rendu serveur.
 *
 * Sans lui, changer d'écran laisse la page précédente figée puis remplacée d'un
 * coup : on ne sait pas si l'application a compris le clic. Un squelette dit
 * « c'est en cours » sans faire clignoter le contenu.
 */
export default function Loading() {
  return (
    <>
      <header className="page-head">
        <span
          style={{
            width: 140,
            height: 15,
            borderRadius: 4,
            background: 'var(--surface-2)',
          }}
        />
      </header>
      <div className="page-body">
        <div className="narrow" style={{ display: 'grid', gap: 'var(--s3)' }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="panel"
              style={{
                height: 62,
                // Une opacité dégressive suggère la profondeur de la liste sans
                // animation : docs/06 §1 interdit ce qui bouge sous le curseur.
                opacity: 1 - i * 0.22,
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
