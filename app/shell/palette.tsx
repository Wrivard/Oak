'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { filtrer, ouvrePalette } from '../../lib/shell/filtre.js';

/**
 * La palette de commandes. Ctrl+K, ou ⌘K.
 *
 * Pourquoi elle existe ici plus qu'ailleurs : cette application se pilote au
 * clavier par construction — la review a huit raccourcis affichés en
 * permanence, l'inventaire a `/`. Mais CHANGER D'ÉCRAN demandait la souris, et
 * c'est le geste le plus fréquent après le tri : on finit un lot, on va voir la
 * santé, on revient. Trois allers-retours vers une barre latérale par minute.
 *
 * Elle ne fait QUE naviguer et chercher. Aucune action destructive, aucune
 * écriture : une palette qui peut fermer un lot est une palette où l'on ferme
 * un lot par erreur, en tapant trop vite sur une entrée qu'on n'a pas fini de
 * lire.
 */
interface Entree {
  titre: string;
  mots?: string | undefined;
  section: string;
  indice?: string | undefined;
  icone?: ReactNode;
  aller: string;
}

const NAV: Omit<Entree, 'section'>[] = [
  { titre: 'Aujourd’hui', mots: 'accueil tâches à faire', aller: '/' },
  { titre: 'Envoyer des photos', mots: 'upload lot scanner dossier', aller: '/upload' },
  { titre: 'Lots', mots: 'batches sessions fermer comptage', aller: '/batches' },
  { titre: 'Review', mots: 'file trier candidats identifier', aller: '/review' },
  { titre: 'Vérifier', mots: 'audit résolutions automatiques empreinte', aller: '/audit' },
  { titre: 'Inventaire', mots: 'stock skus quantités', aller: '/inventory' },
  { titre: 'Prix', mots: 'pricing règles bandes plancher', aller: '/pricing' },
  { titre: 'Diagnostic', mots: 'matching ocr ère bande crop', aller: '/diagnostics' },
  { titre: 'Santé', mots: 'dashboard tableau de bord worker jobs morts', aller: '/dashboard' },
];

/** Les filtres d'inventaire qu'on ouvre le plus souvent depuis ailleurs. */
const RACCOURCIS: Omit<Entree, 'section'>[] = [
  {
    titre: 'SKUs sans prix',
    mots: 'inventaire non prixé unpriced',
    aller: '/inventory?filter=unpriced',
  },
  {
    titre: 'SKUs non listés',
    mots: 'inventaire unlisted ebay',
    aller: '/inventory?filter=unlisted',
  },
  {
    titre: 'Résolutions les moins sûres',
    mots: 'audit vérifier doute confiance',
    aller: '/audit?sort=doubtful',
  },
];

export default function Palette({ lots }: { lots: { nom: string; review: number }[] }) {
  const router = useRouter();
  const [ouverte, setOuverte] = useState(false);
  const [q, setQ] = useState('');
  const [curseur, setCurseur] = useState(0);
  const champ = useRef<HTMLInputElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);

  const entrees = useMemo<Entree[]>(() => {
    const base: Entree[] = [
      ...NAV.map((e) => ({ ...e, section: 'Aller à' })),
      // Les lots qui ont encore des cartes à trier, AVANT les vues génériques :
      // « Ctrl+K, bulk » doit mener aux dix-neuf cartes de `bulk-vintage`, pas
      // obliger à passer par l'écran des lots pour recopier un nom.
      ...lots.map((l) => ({
        titre: `Reviewer ${l.nom}`,
        mots: `lot session ${l.nom}`,
        section: 'Lots à trier',
        indice: `${l.review} carte${l.review > 1 ? 's' : ''}`,
        aller: `/review?lot=${encodeURIComponent(l.nom)}`,
      })),
      ...RACCOURCIS.map((e) => ({ ...e, section: 'Vues' })),
    ];
    const trouvees = filtrer(base, q);

    // La recherche d'inventaire est toujours LA DERNIÈRE entrée, jamais la
    // première : taper « prix » doit ouvrir l'écran des prix, pas chercher une
    // carte nommée « prix ». Elle n'apparaît qu'à partir de deux caractères —
    // une seule lettre trouve tout et ne cherche rien.
    const terme = q.trim();
    if (terme.length >= 2) {
      trouvees.push({
        titre: `Chercher « ${terme} » dans l’inventaire`,
        section: 'Recherche',
        indice: 'ouvre /inventory',
        aller: `/inventory?q=${encodeURIComponent(terme)}`,
      });
    }
    return trouvees;
  }, [q, lots]);

  const fermer = useCallback(() => {
    setOuverte(false);
    setQ('');
    setCurseur(0);
  }, []);

  const lancer = useCallback(
    (e: Entree | undefined) => {
      if (e === undefined) return;
      fermer();
      router.push(e.aller);
    },
    [fermer, router],
  );

  /** Ctrl+K / ⌘K ouvre, où qu'on soit — y compris depuis un champ de saisie. */
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ouvrePalette(ev)) {
        ev.preventDefault();
        setOuverte((v) => !v);
        return;
      }
      if (ev.key === 'Escape' && ouverte) {
        ev.preventDefault();
        fermer();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ouverte, fermer]);

  useEffect(() => {
    if (ouverte) setTimeout(() => champ.current?.focus(), 0);
  }, [ouverte]);

  // Le curseur revient en tête à chaque frappe : sinon il reste sur la
  // troisième ligne d'une liste qui n'en a plus que deux.
  useEffect(() => setCurseur(0), [q]);

  // La ligne active reste visible sans que la liste saute : `nearest`, comme
  // la file de review.
  useEffect(() => {
    listeRef.current
      ?.querySelector('[data-actif="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [curseur, entrees]);

  if (!ouverte) return null;

  const bouger = (d: number): void =>
    setCurseur((c) => {
      if (entrees.length === 0) return 0;
      return (c + d + entrees.length) % entrees.length;
    });

  let sectionRendue = '';

  return (
    // Le fond assombri ferme au clic : c'est le geste de quelqu'un qui a ouvert
    // la palette par erreur, et il ne doit pas avoir à viser une croix.
    <div className="palette-fond" onMouseDown={fermer} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Palette de commandes"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-champ">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" strokeLinecap="round" />
          </svg>
          <input
            ref={champ}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Aller à un écran, chercher une carte…"
            aria-label="Rechercher"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                bouger(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                bouger(-1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                lancer(entrees[curseur]);
              }
            }}
          />
          <kbd>Échap</kbd>
        </div>

        <div className="palette-liste" ref={listeRef}>
          {entrees.length === 0 && (
            <div className="palette-vide">Rien ne correspond à « {q.trim()} ».</div>
          )}
          {entrees.map((e, i) => {
            const nouvelleSection = e.section !== sectionRendue;
            sectionRendue = e.section;
            return (
              <div key={`${e.section}-${e.titre}`}>
                {nouvelleSection && <div className="palette-section">{e.section}</div>}
                <button
                  className="palette-item"
                  data-actif={i === curseur ? 'true' : undefined}
                  onMouseMove={() => setCurseur(i)}
                  onClick={() => lancer(e)}
                >
                  <span className="palette-titre">{e.titre}</span>
                  {e.indice !== undefined && (
                    <span className="palette-indice">{e.indice}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-pied">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> naviguer
          </span>
          <span>
            <kbd>Entrée</kbd> ouvrir
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <kbd>Ctrl</kbd> <kbd>K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
