'use client';

import { useEffect } from 'react';

/**
 * Ce qu'on voit quand une page casse.
 *
 * L'écran par défaut de Next affiche « Application error: a server-side
 * exception has occurred » et un digest — c'est-à-dire rien d'actionnable. Ici
 * on donne la cause probable et le geste à faire, parce que la panne la plus
 * fréquente est toujours la même : la base est injoignable.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // La console du navigateur garde le détail : le message affiché reste court.
    console.error('[pokelister]', error);
  }, [error]);

  const baseInjoignable =
    /DATABASE_URL|ECONNREFUSED|timeout|connect|EMAXCONN/i.test(error.message);

  return (
    <div className="page-body">
      <div className="narrow">
        <div className="note note--alarm">
          <strong>Cette page n’a pas pu se charger.</strong>
        </div>

        <div className="panel" style={{ marginTop: 'var(--s3)' }}>
          {baseInjoignable ? (
            <>
              <p style={{ marginTop: 0 }}>
                La base de données ne répond pas. Les causes, par ordre de fréquence :
              </p>
              <ul className="dim" style={{ fontSize: 13 }}>
                <li>
                  <span className="mono">DATABASE_URL</span> absent ou faux dans{' '}
                  <span className="mono">.env.local</span>
                </li>
                <li>
                  trop de connexions ouvertes — le pooler est limité à 15, voir{' '}
                  <span className="mono">PG_POOL_MAX</span>
                </li>
                <li>le projet Supabase est en pause</li>
              </ul>
            </>
          ) : (
            <p style={{ marginTop: 0 }} className="dim">
              Le détail est dans la console du navigateur et dans la fenêtre de
              l’application.
            </p>
          )}

          <pre
            className="mono faint"
            style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 'var(--s3) 0 0' }}
          >
            {error.message}
          </pre>

          <button className="btn btn--primary" onClick={reset} style={{ marginTop: 'var(--s3)' }}>
            Réessayer
          </button>
        </div>
      </div>
    </div>
  );
}
