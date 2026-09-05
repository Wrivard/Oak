'use client';

import { useEffect, useState } from 'react';

/**
 * Aide clavier. Voir docs/06-ui.md §6.
 *
 * Les raccourcis principaux sont affichés en permanence en bas d'écran — un
 * raccourci qu'il faut mémoriser sans rappel visuel ne sera pas utilisé. Cette
 * fiche complète, elle, sert aux premières heures et aux touches secondaires.
 */
const RACCOURCIS: { touches: string[]; action: string; note?: string }[] = [
  { touches: ['↑', '↓'], action: 'Carte précédente / suivante', note: 'ou J et K' },
  { touches: ['1', '…', '5'], action: 'Choisir le candidat n' },
  { touches: ['A'], action: 'Accepter et passer à la suivante', note: 'le chemin nominal' },
  { touches: ['E'], action: 'Éditer le prix final' },
  { touches: ['X'], action: 'Passer sans résoudre', note: 'la carte reste en file' },
  { touches: ['S'], action: 'Rechercher dans le catalogue' },
  { touches: ['R'], action: 'Écarter — pas une carte', note: 'intercalaire, page blanche' },
  { touches: ['U'], action: 'Annuler la dernière confirmation' },
  { touches: ['Échap'], action: 'Sortir d’un champ de saisie' },
  { touches: ['?'], action: 'Afficher cette aide' },
];

export default function HelpOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA';

      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (typing) return;
      if (e.key === '?') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,0.6)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{ width: 460, maxWidth: '90vw', padding: 'var(--s5)' }}
      >
        <div className="panel-head">
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Raccourcis</h2>
          <span className="faint" style={{ fontSize: 11, marginLeft: 'auto' }}>
            Échap pour fermer
          </span>
        </div>

        <table className="table">
          <tbody>
            {RACCOURCIS.map((r) => (
              <tr key={r.action}>
                <td style={{ width: 110 }}>
                  {r.touches.map((t, i) => (
                    <span key={i}>
                      {t === '…' ? (
                        <span className="faint" style={{ margin: '0 2px' }}>
                          …
                        </span>
                      ) : (
                        <kbd style={{ marginRight: 3 }}>{t}</kbd>
                      )}
                    </span>
                  ))}
                </td>
                <td style={{ textAlign: 'left' }}>
                  {r.action}
                  {r.note && (
                    <span className="faint" style={{ fontSize: 11 }}>
                      {' '}
                      — {r.note}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="faint" style={{ fontSize: 11, marginTop: 'var(--s3)', marginBottom: 0 }}>
          Toute saisie dans un champ suspend les raccourcis à une lettre — sinon taper
          « alakazam » déclencherait accept.
        </p>
      </div>
    </div>
  );
}
