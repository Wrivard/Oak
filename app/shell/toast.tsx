'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Les avis d'action. Voir docs/06-ui.md.
 *
 * Le problème qu'ils résolvent : la plupart des actions de cette application
 * réussissaient EN SILENCE. On enregistrait des règles de prix et le seul
 * retour était le mot « enregistré » en gris clair, à côté d'un bouton, à
 * l'autre bout de l'écran de l'endroit où on venait de cliquer. On fermait un
 * lot et la ligne changeait quelque part dans un tableau. Une action dont on ne
 * voit pas l'effet se refait « au cas où » — et refaire une action qui écrit en
 * base est exactement ce qu'on ne veut pas ici.
 *
 * CE QUI NE DOIT PAS EN RECEVOIR : l'acceptation d'une carte en review. Trois
 * secondes par carte, mille cartes par soirée : mille avis empilés dans le coin
 * de l'écran seraient le bruit le plus cher de l'application. Cet écran a déjà
 * son retour — le flash sur l'image, le compteur, la carte suivante. Un avis
 * sert aux actions RARES dont l'effet est ailleurs.
 */
export type TonAvis = 'ok' | 'warn' | 'alarm';

interface Avis {
  id: number;
  ton: TonAvis;
  titre: string;
  detail?: string | undefined;
}

interface Api {
  /** Affiche un avis. Retourne son identifiant, pour pouvoir le retirer. */
  avis: (ton: TonAvis, titre: string, detail?: string) => number;
  retirer: (id: number) => void;
}

const Ctx = createContext<Api | null>(null);

/**
 * Combien de temps un avis reste.
 *
 * Une erreur reste DEUX FOIS plus longtemps qu'une confirmation : on lit
 * « enregistré » du coin de l'oeil, on lit une erreur en s'arrêtant. Et une
 * alarme ne part jamais toute seule — si l'écriture a échoué, la voir
 * disparaître pendant qu'on regardait ailleurs est pire que pas d'avis du tout.
 */
const DUREE: Record<TonAvis, number> = { ok: 3500, warn: 7000, alarm: 0 };

/** Au-delà, la pile mange l'écran ; les plus anciens partent en premier. */
const MAX = 4;

export function useAvis(): Api {
  const api = useContext(Ctx);
  if (api === null) {
    // Le provider vit dans la coquille : un composant hors coquille est un bug
    // de structure, pas un cas à gérer en silence.
    throw new Error('useAvis hors de <AvisProvider>');
  }
  return api;
}

export function AvisProvider({ children }: { children: ReactNode }) {
  const [liste, setListe] = useState<Avis[]>([]);
  const suivant = useRef(1);

  const retirer = useCallback((id: number) => {
    setListe((l) => l.filter((a) => a.id !== id));
  }, []);

  const avis = useCallback((ton: TonAvis, titre: string, detail?: string) => {
    const id = suivant.current++;
    setListe((l) => [...l, { id, ton, titre, detail }].slice(-MAX));
    return id;
  }, []);

  const api = useMemo(() => ({ avis, retirer }), [avis, retirer]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="avis-pile" role="status" aria-live="polite">
        {liste.map((a) => (
          <AvisCarte key={a.id} avis={a} onRetirer={retirer} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

const ICONE: Record<TonAvis, ReactNode> = {
  ok: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M12 8v5" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" />
      <path d="M12 3.5 2.5 20h19L12 3.5Z" strokeLinejoin="round" />
    </svg>
  ),
  alarm: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
};

function AvisCarte({ avis, onRetirer }: { avis: Avis; onRetirer: (id: number) => void }) {
  const [survol, setSurvol] = useState(false);

  /**
   * Le compte à rebours SE MET EN PAUSE au survol.
   *
   * Un avis qui porte un détail — le nom d'une carte, un message d'erreur — se
   * lit en trois secondes seulement si on l'attrape tout de suite. Approcher la
   * souris est le geste de quelqu'un qui veut le lire ; le faire disparaître à
   * ce moment-là est le pire moment possible.
   */
  useEffect(() => {
    const duree = DUREE[avis.ton];
    if (duree === 0 || survol) return;
    const t = setTimeout(() => onRetirer(avis.id), duree);
    return () => clearTimeout(t);
  }, [avis.id, avis.ton, survol, onRetirer]);

  return (
    <div
      className="avis"
      data-ton={avis.ton}
      onMouseEnter={() => setSurvol(true)}
      onMouseLeave={() => setSurvol(false)}
    >
      <span className="avis-icone">{ICONE[avis.ton]}</span>
      <span className="avis-texte">
        <span className="avis-titre">{avis.titre}</span>
        {avis.detail !== undefined && avis.detail !== '' && (
          <span className="avis-detail">{avis.detail}</span>
        )}
      </span>
      <button
        className="avis-fermer"
        onClick={() => onRetirer(avis.id)}
        aria-label="Fermer"
        title="Fermer"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
