'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Une confirmation qui dit ce qu'elle engage.
 *
 * Le cas qui l'a fait écrire : fermer un lot dont le comptage ne balance pas.
 * Le refus s'affichait en rouge dans une cellule de tableau, et un second
 * bouton apparaissait dessous — « Fermer quand même ». Deux boutons de la même
 * taille, dans une case de deux cents pixels, pour une décision qui fige un
 * écart d'inventaire en base. On clique sur le second sans avoir lu le premier.
 *
 * Le bouton de confirmation N'A PAS le focus à l'ouverture. C'est le bouton
 * d'annulation qui l'a : sur une action irréversible, un `Entrée` réflexe doit
 * annuler, pas confirmer.
 */
export default function Dialogue({
  ouvert,
  titre,
  children,
  confirmer,
  annuler,
  onConfirmer,
  onAnnuler,
  danger,
}: {
  ouvert: boolean;
  titre: string;
  children: ReactNode;
  confirmer: string;
  annuler?: string;
  onConfirmer: () => void;
  onAnnuler: () => void;
  danger?: boolean;
}) {
  const refAnnuler = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!ouvert) return;
    setTimeout(() => refAnnuler.current?.focus(), 0);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onAnnuler();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ouvert, onAnnuler]);

  if (!ouvert) return null;

  return (
    <div className="dialogue-fond" onMouseDown={onAnnuler} role="presentation">
      <div
        className="dialogue"
        role="alertdialog"
        aria-modal="true"
        aria-label={titre}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="dialogue-titre">{titre}</h2>
        <div className="dialogue-corps">{children}</div>
        <div className="dialogue-pied">
          <button ref={refAnnuler} className="btn" onClick={onAnnuler}>
            {annuler ?? 'Annuler'}
          </button>
          <button
            className={`btn${danger === true ? ' btn--danger' : ' btn--primary'}`}
            onClick={onConfirmer}
          >
            {confirmer}
          </button>
        </div>
      </div>
    </div>
  );
}
