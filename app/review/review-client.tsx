'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmScan,
  loadMore,
  rejectScan,
  searchCatalog,
  type SearchHit,
} from './actions.js';
import HelpOverlay from './help-overlay.js';
import type { ReviewScan } from './queries.js';
import { candidatDuNumero } from '../../lib/review/numero.js';
import { formatCents, netAfterFees, parseAmount } from '../../lib/pricing/net.js';
import { FEES } from '../../lib/config/fees.js';
import type { CardCondition, CardVariant } from '../../lib/sku.js';

/**
 * File de review. Voir docs/06-ui.md.
 *
 * Budget : 3 secondes par carte. Le clavier fait tout, la souris est une
 * commodité. Chaque clic nécessaire est un bug.
 */
interface Props {
  scans: ReviewScan[];
  thresholds: { autoAcceptMax: number; hardReviewMin: number };
  variants: readonly CardVariant[];
  conditions: readonly CardCondition[];
  feesVerified: boolean;
}

type Tier = 'bulk' | 'watch' | 'hard';

function tierOf(valueCents: number | null, t: Props['thresholds']): Tier {
  if (valueCents === null) return 'bulk';
  const v = valueCents / 100;
  if (v >= t.hardReviewMin) return 'hard';
  if (v >= t.autoAcceptMax) return 'watch';
  return 'bulk';
}

/** Noms lisibles des sources. `ebay_active` n'est pas un prix obtenu. */
const SOURCE_LABEL: Record<string, string> = {
  ebay_active: 'eBay — annonces actives',
  ebay_sold: 'eBay — ventes passées',
  tcgplayer: 'TCGplayer',
  cardmarket: 'Cardmarket (EUR)',
};

const TIER_COLOR: Record<Tier, string> = {
  bulk: 'var(--border)',
  watch: 'var(--amber)',
  hard: 'var(--red)',
};

/** Bip synthétisé : un asset externe serait bloqué et silencieux. */
function beep(tier: Tier): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = tier === 'hard' ? 880 : 560;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
    setTimeout(() => void ctx.close(), 300);
  } catch {
    // Le son est un doublon du signal visuel (docs/06 §7). S'il échoue —
    // autoplay bloqué, pas de périphérique — l'information reste à l'écran.
  }
}

export default function ReviewClient({
  scans,
  thresholds,
  variants,
  conditions,
  feesVerified,
}: Props) {
  const [queue, setQueue] = useState(scans);
  const [cursor, setCursor] = useState(0);
  /**
   * La sélection est calculée DÈS LE PREMIER RENDU, pas dans un effet.
   *
   * Un effet ne s'exécute qu'après l'hydratation : le serveur rendait la
   * première ligne en surbrillance, puis le navigateur déplaçait la
   * surbrillance sur la ligne désignée par le numéro. Un sautillement à chaque
   * ouverture de la file, sur l'élément qu'on regarde en priorité.
   */
  const [chosen, setChosen] = useState(
    () => candidatDuNumero(scans[0]?.ocrRead, scans[0]?.candidates ?? []) ?? 0,
  );
  const [variant, setVariant] = useState<CardVariant | null>(null);
  const [condition, setCondition] = useState<CardCondition | null>(null);
  const [priceText, setPriceText] = useState('');
  const [editing, setEditing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  /** Cartes parties en optimiste, gardées pour pouvoir les remettre. */
  const [undoStack, setUndoStack] = useState<{ scan: ReviewScan; at: number }[]>([]);
  const [treated, setTreated] = useState(0);
  const startedAt = useRef(Date.now());
  /** Confirmations en vol : elles ne bloquent pas l'écran, mais on les compte. */
  const [inFlight, setInFlight] = useState(0);

  const priceRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const scan = queue[cursor];

  /**
   * Le candidat que le numéro lu désigne, ou `null`.
   *
   * C'est le seul indice DÉTERMINISTE de l'écran : une distance CLIP dit « ça
   * se ressemble », un numéro imprimé dit « c'est cette édition-là ». Deux
   * réimpressions du même artwork ne se séparent que par lui.
   */
  const indiceNumero = useMemo(
    () => (scan ? candidatDuNumero(scan.ocrRead, scan.candidates) : null),
    [scan],
  );

  useEffect(() => {
    try {
      setSound(localStorage.getItem('review.sound') === '1');
    } catch {
      // Mode privé ou stockage bloqué : le son reste coupé, c'est le défaut.
    }
  }, []);

  /**
   * Réinitialise l'édition quand LA CARTE change — pas quand le curseur bouge.
   *
   * La différence n'est pas théorique. `accept` retire la carte de la file et
   * laisse le curseur où il est : la position ne change pas, la carte sous le
   * curseur, si. Avec `[cursor]` en dépendance, la réinitialisation ne partait
   * donc PAS après une acceptation — un prix tapé pour la carte N restait dans
   * le champ pour la carte N+1, et un second appui sur `A` l'écrivait en base
   * sur la mauvaise carte. C'est exactement ce que ce bloc existait pour
   * empêcher.
   *
   * `indiceNumero` n'est volontairement pas une dépendance : l'effet se ferme
   * sur la valeur du rendu où la carte a changé, qui est la bonne. L'ajouter
   * ferait repartir la réinitialisation quand on choisit une carte par la
   * recherche — l'objet du scan est recréé, la liste des candidats change, et
   * on effacerait la sélection que l'utilisateur vient de faire.
   *
   * La sélection part du candidat que le NUMÉRO désigne, et non du premier de
   * la liste. Le premier de la liste est simplement le plus proche au sens
   * CLIP, ce qui ne départage justement pas deux réimpressions du même
   * artwork. La ligne est badgée à l'écran : on voit pourquoi elle est choisie.
   */
  useEffect(() => {
    setChosen(indiceNumero ?? 0);
    setVariant(null);
    setCondition(null);
    setPriceText('');
    setEditing(false);
    setSearching(false);
    setHits([]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan?.id]);

  const tier = useMemo(() => tierOf(scan?.valueCents ?? null, thresholds), [scan, thresholds]);

  /**
   * Préchargement des voisines.
   *
   * Sans ça, chaque flèche déclenche un téléchargement à froid et l'image
   * apparaît après coup. Les deux suivantes et la précédente suffisent : on ne
   * navigue jamais plus vite que ça, et précharger toute la file gaspillerait la
   * bande passante sur des cartes qu'on ne verra pas.
   *
   * On précharge AUSSI les images des candidats. Ce sont elles qui coûtent : le
   * scan vient du disque local, les candidats viennent de pokemontcg.io. Et ce
   * sont précisément celles qu'il faut comparer pour décider — arriver sur une
   * carte dont les cinq vignettes se chargent encore, c'est le budget de trois
   * secondes dépensé à attendre.
   *
   * Les objets Image sont retenus dans une ref : un `new Image()` laissé sans
   * référence peut être ramassé avant la fin du téléchargement, et le
   * préchargement ne sert alors à rien.
   */
  const prefetched = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    const held: HTMLImageElement[] = [];
    const charger = (src: string): void => {
      const img = new Image();
      img.src = src;
      held.push(img);
    };

    for (const offset of [1, 2, -1]) {
      const neighbour = queue[cursor + offset];
      if (!neighbour) continue;
      charger(`/api/scan/${neighbour.id}/image`);
      // Deux candidats suffisent : au-delà, on ouvre la recherche de toute façon.
      for (const c of neighbour.candidates.slice(0, 2)) {
        if (c.image) charger(c.image);
      }
    }
    prefetched.current = held;
  }, [cursor, queue]);

  /**
   * Garde la ligne focalisée visible.
   *
   * `block: 'nearest'` volontairement : la liste ne saute que quand le curseur
   * sort du cadre. Recentrer à chaque flèche donnerait un écran qui bouge sous
   * les yeux, ce que docs/06 §1 interdit explicitement.
   */
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  useEffect(() => {
    const id = queue[cursor]?.id;
    if (id) rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, queue]);

  /**
   * Image introuvable.
   *
   * docs/02 §6 prévoit de supprimer les originaux une fois l'URL eBay obtenue :
   * une image absente est un cas NORMAL, pas une panne. Elle doit se dire, pas
   * afficher une icône cassée que personne ne sait interpréter.
   */
  const [imageManquante, setImageManquante] = useState(false);
  useEffect(() => setImageManquante(false), [scan?.id]);

  /** Confirmation visuelle brève : on doit SAVOIR que l'appui a été pris. */
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 160);
    return () => clearTimeout(t);
  }, [flash]);

  /**
   * Réapprovisionnement automatique, sur une horloge.
   *
   * On recharge quand il reste moins de 40 cartes, pas quand la file est vide :
   * le chargement doit être fini AVANT qu'on en ait besoin, sinon on attend, et
   * attendre est précisément ce qu'on cherche à supprimer. À 3 s par carte,
   * 40 cartes laissent deux minutes de marge.
   *
   * SUR UNE HORLOGE, et pas en réaction à `queue`, pour deux raisons :
   *
   *   - déclenché par `queue`, il repartait à CHAQUE carte confirmée dès que la
   *     file passait sous 40. Sur un petit arriéré, chaque appui sur A lançait
   *     une requête qui rapportait zéro ligne — et `loadMore` en demande 200 de
   *     plus que ce qu'on exclut.
   *   - et surtout : file vide, `queue` ne change plus, donc l'effet ne se
   *     relançait JAMAIS. On restait sur « Rien à reviewer » pendant que le
   *     worker résolvait la suite du lot juste derrière. Il fallait recharger la
   *     page pour s'en apercevoir.
   */
  const refilling = useRef(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    let vivant = true;

    const remplir = async (): Promise<void> => {
      if (!vivant || refilling.current) return;
      // Onglet caché : personne ne trie, rien à précharger. On rattrape au
      // retour, par l'écouteur ci-dessous.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const courante = queueRef.current;
      if (courante.length >= 40) return;

      refilling.current = true;
      try {
        const more = await loadMore(courante.map((s) => s.id));
        if (vivant && more.length > 0) setQueue((q) => [...q, ...more]);
      } catch (err) {
        if (vivant) setError(`chargement de la suite : ${String(err)}`);
      } finally {
        refilling.current = false;
      }
    };

    void remplir();
    const t = setInterval(() => void remplir(), 5000);
    const onVisible = (): void => void remplir();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      vivant = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  /**
   * Écarte la carte courante. Optimiste comme l'accept : l'écriture part
   * derrière, la carte quitte la file tout de suite.
   */
  const reject = useCallback(() => {
    if (!scan) return;
    const position = cursor;
    setError(null);
    setQueue((q) => q.filter((s) => s.id !== scan.id));
    setUndoStack((u) => [{ scan, at: position }, ...u].slice(0, 10));

    void rejectScan(scan.id).then((res) => {
      if (res.ok) return;
      setError(res.error ?? 'échec');
      setQueue((q) => [...q.slice(0, position), scan, ...q.slice(position)]);
    });
  }, [scan, cursor]);

  /** Annule la dernière confirmation en la remettant à sa place. */
  const undo = useCallback(() => {
    setUndoStack((u) => {
      const [last, ...rest] = u;
      if (!last) return u;
      setQueue((q) => [...q.slice(0, last.at), last.scan, ...q.slice(last.at)]);
      setCursor(last.at);
      setTreated((n) => Math.max(0, n - 1));
      setError(
        'Carte remise en file. La confirmation déjà partie n’est PAS annulée en base — corrige-la à la main si besoin.',
      );
      return rest;
    });
  }, []);

  useEffect(() => {
    if (sound && (tier === 'watch' || tier === 'hard')) beep(tier);
  }, [scan?.id, tier, sound]);

  const effVariant = variant ?? scan?.default_variant ?? 'normal';
  const effCondition = condition ?? scan?.default_condition ?? 'NM';
  const candidate = scan?.candidates[chosen];

  const move = useCallback(
    (d: number) => setCursor((c) => Math.min(Math.max(c + d, 0), Math.max(queue.length - 1, 0))),
    [queue.length],
  );

  /**
   * Accept OPTIMISTE.
   *
   * L'écriture prend un aller-retour vers la base — quelques centaines de
   * millisecondes sur un pooler distant. Sur un budget de 3 secondes par carte,
   * attendre cette réponse avant de passer à la suivante gaspille un dixième du
   * budget ET fige l'écran, ce qui est pire que la lenteur elle-même.
   *
   * La carte quitte donc la file IMMÉDIATEMENT et l'écriture part en arrière-
   * plan. Si elle échoue, la carte revient à sa place avec l'erreur affichée :
   * rien n'est perdu, on est juste interrompu — ce qui est le bon compromis,
   * puisque l'échec est rare et l'attente permanente.
   */
  const accept = useCallback(() => {
    if (!scan || !candidate) return;
    const position = cursor;
    const payload = {
      scanId: scan.id,
      cardId: candidate.card_id,
      variant: effVariant,
      condition: effCondition,
      language: scan.default_language,
      priceCents: priceText === '' ? null : parseAmount(priceText),
    };

    setError(null);
    setFlash(true);
    setQueue((q) => q.filter((s) => s.id !== scan.id));
    setUndoStack((u) => [{ scan, at: position }, ...u].slice(0, 10));
    setTreated((n) => n + 1);
    setInFlight((n) => n + 1);

    void confirmScan(payload)
      .then((res) => {
        if (res.ok) return;
        setError(`${scan.candidates[chosen]?.name ?? scan.id} : ${res.error ?? 'échec'}`);
        // Remise à sa place, pas en fin de file : on la retrouve où on l'a
        // laissée plutôt que de devoir la rechercher.
        setQueue((q) => [...q.slice(0, position), scan, ...q.slice(position)]);
        setTreated((n) => Math.max(0, n - 1));
      })
      .catch((err: unknown) => {
        setError(String(err));
        setQueue((q) => [...q.slice(0, position), scan, ...q.slice(position)]);
        setTreated((n) => Math.max(0, n - 1));
      })
      .finally(() => setInFlight((n) => Math.max(0, n - 1)));
  }, [scan, candidate, cursor, chosen, effVariant, effCondition, priceText]);

  /**
   * Recherche débouncée.
   *
   * Sans ça, taper « charizard » lance neuf requêtes serveur dont huit sont
   * jetées, et les réponses peuvent revenir dans le désordre — l'utilisateur
   * voit alors les résultats de « chariz » après ceux de « charizard ».
   * Le compteur de génération règle aussi ce second problème.
   */
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchGen = useRef(0);

  const runSearch = useCallback((term: string) => {
    clearTimeout(searchTimer.current);
    const gen = ++searchGen.current;
    searchTimer.current = setTimeout(() => {
      void searchCatalog(term).then((r) => {
        // Réponse périmée : une frappe plus récente est déjà partie.
        if (gen === searchGen.current) setHits(r);
      });
    }, 180);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el?.tagName === 'INPUT' || el?.tagName === 'SELECT' || el?.tagName === 'TEXTAREA';

      // Échap sort de tout champ : c'est la porte de sortie universelle.
      if (e.key === 'Escape') {
        setEditing(false);
        setSearching(false);
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      // Toute saisie suspend les raccourcis à une lettre — sinon taper
      // « alakazam » déclenche accept (docs/06 §6).
      if (typing) return;

      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); return; }
      if (/^[1-5]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (scan && i < scan.candidates.length) setChosen(i);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); void accept(); return; }
      if (k === 'x') { e.preventDefault(); move(1); return; }
      if (k === 'e') {
        e.preventDefault();
        setEditing(true);
        setTimeout(() => priceRef.current?.focus(), 0);
        return;
      }
      if (k === 's') {
        e.preventDefault();
        setSearching(true);
        setTimeout(() => searchRef.current?.focus(), 0);
        return;
      }
      if (k === 'u') {
        e.preventDefault();
        undo();
        return;
      }
      if (k === 'r') {
        e.preventDefault();
        reject();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accept, move, scan, undo, reject]);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem('review.sound', next ? '1' : '0');
    } catch {
      // Préférence de confort : si le stockage refuse, l'état vit pour la session.
    }
  }

  const secPerCard = treated === 0 ? 0 : (Date.now() - startedAt.current) / 1000 / treated;

  if (queue.length === 0) {
    return (
      <>
        <HelpOverlay />
        <header className="page-head">
          <h1 className="page-title">Review</h1>
        </header>
        <div className="page-body">
          <div className="empty">
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {refilling.current ? 'Chargement…' : 'Rien à reviewer'}
            </div>
            <div className="dim">
              {refilling.current
                ? 'Récupération des scans suivants.'
                : 'Tout ce qui est entré a été résolu par les niveaux 1 et 2.'}
            </div>
            {/* Sans cette ligne, on recharge la page à la main pendant que le
                worker travaille juste derrière. La file se remplit seule. */}
            {!refilling.current && (
              <div className="faint" style={{ fontSize: 12, marginTop: 'var(--s2)' }}>
                Cette page se remplit d&apos;elle-même : inutile de recharger si le
                worker traite encore un lot.
              </div>
            )}
            {treated > 0 && (
              <div className="mono faint" style={{ marginTop: 'var(--s2)' }}>
                {treated} traitées cette session · {secPerCard.toFixed(1)} s/carte
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  const priceCents = priceText === '' ? null : parseAmount(priceText);
  /** Saisie non vide que `parseAmount` refuse : à dire, pas à ignorer. */
  const prixIllisible = priceText.trim() !== '' && priceCents === null;
  const soldSales = scan?.prices.find((p) => p.source === 'ebay_sold')?.sales ?? [];
  const variantDiverge = effVariant !== scan?.default_variant;

  return (
    <>
      <HelpOverlay />
      <header className="page-head">
        <h1 className="page-title">Review</h1>
        <span className="page-sub">
          {scan?.session_name} · #{scan?.seq}
        </span>
        <div className="page-actions">
          {treated > 0 && (
            <span className="mono faint" style={{ fontSize: 12 }}>
              {treated} traitées ·{' '}
              <span style={{ color: secPerCard <= 3 ? 'var(--green)' : 'var(--amber)' }}>
                {secPerCard.toFixed(1)} s/carte
              </span>
            </span>
          )}
          {inFlight > 0 && (
            <span className="mono faint" title="écritures en cours">
              ⟳ {inFlight}
            </span>
          )}
          <button className="btn btn--ghost" onClick={toggleSound} title="Alerte sonore">
            {sound ? 'son on' : 'son off'}
          </button>
        </div>
      </header>

      {/* La largeur de la file est en CSS et non en style en ligne : sur un
          écran étroit elle doit se réduire, et un style en ligne ne se laisse
          pas surcharger par une media query. */}
      <div className="page-body page-body--flush review-body">
        {/* File compacte : 30 px par ligne. On en voit le plus possible sans que
            les cibles deviennent difficiles à viser. Elle RECULE — c'est un
            index, pas le travail. */}
        <aside className="file">
          <div className="file-tete">
            <span className="label">{queue.length} en attente</span>
          </div>
          {queue.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => {
                if (el) rowRefs.current.set(s.id, el);
                else rowRefs.current.delete(s.id);
              }}
              onClick={() => setCursor(i)}
              className="file-ligne"
              data-actif={i === cursor}
            >
              <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>
                {s.seq}
              </span>
              <span className="file-nom">{s.candidates[0]?.name ?? 'inconnue'}</span>
              {s.variant_conflict && (
                <span className="dot dot--alarm" title="conflit de variant" />
              )}
            </button>
          ))}
        </aside>

        <main className="review-grid">
          {/*
            LA COMPARAISON. La décision de cet écran est visuelle : « est-ce
            bien CETTE édition-là ». Elle se prend en posant les deux images
            côte à côte, à la MÊME taille — un scan de 240 px contre une
            vignette de candidat de 42 px ne se compare pas, on ne voit ni le
            symbole d'extension, ni le cadre, ni le fond d'illustration, et ce
            sont exactement les trois choses qui séparent deux réimpressions.

            À droite, la carte SÉLECTIONNÉE, pas la première : appuyer sur 1-5
            change l'image de droite, et comparer devient une seule touche.
          */}
          <div className="compare">
            <figure className="compare-vue">
              <figcaption className="compare-tete">
                <span className="label">Scan</span>
                {!imageManquante && (
                  <a
                    href={`/api/scan/${scan?.id}/image?full=1`}
                    target="_blank"
                    rel="noreferrer"
                    className="faint"
                    style={{ fontSize: 11 }}
                  >
                    pleine résolution
                  </a>
                )}
              </figcaption>
              {imageManquante ? (
                <div className="compare-vide">
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Image indisponible</span>
                  <span style={{ fontSize: 11 }}>
                    Le fichier a été déplacé ou purgé. Les candidats et le numéro lu
                    restent exploitables.
                  </span>
                </div>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/scan/${scan?.id}/image`}
                  alt={`scan ${scan?.seq}`}
                  onError={() => setImageManquante(true)}
                  className="compare-img"
                  style={{
                    borderColor: flash ? 'var(--green)' : TIER_COLOR[tier],
                    opacity: flash ? 0.5 : 1,
                  }}
                />
              )}
            </figure>

            <figure className="compare-vue">
              <figcaption className="compare-tete">
                <span className="label">
                  {candidate ? `Candidat ${chosen + 1}` : 'Candidat'}
                </span>
                {candidate?.number && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: chosen === indiceNumero ? 'var(--green)' : 'var(--text-faint)',
                    }}
                  >
                    {candidate.number}/{candidate.printedTotal ?? '—'}
                  </span>
                )}
              </figcaption>
              {candidate?.image ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={candidate.image}
                  alt={candidate.name}
                  loading="eager"
                  decoding="async"
                  className="compare-img"
                />
              ) : (
                <div className="compare-vide">
                  <span style={{ fontSize: 12 }}>
                    {scan?.candidates.length === 0
                      ? 'Aucun candidat proposé'
                      : 'Pas d’image au catalogue'}
                  </span>
                </div>
              )}
            </figure>
          </div>

          {/* Colonne du milieu : LA DÉCISION. Rien d'autre ne doit s'y trouver. */}
          <div className="review-col">
            {scan?.variant_conflict && (
              <div className="note note--alarm">
                Conflit de variant — une empreinte connue de cette carte porte un variant
                différent du défaut de session. Vérifie avant d&apos;accepter.
              </div>
            )}

            {/* Pourquoi cette carte est ici. Sans ce chiffre, «l'OCR a raté»
                reste une supposition — et c'est la donnée de l'expérience 1bis. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s2)',
                fontSize: 12,
              }}
            >
              <span className="label">Numéro lu</span>
              {scan?.ocrRead ? (
                <>
                  <span className="mono" style={{ color: 'var(--green)' }}>
                    {scan.ocrRead}
                  </span>
                  {scan.ocrBand !== null && (
                    <span className="faint" style={{ fontSize: 11 }}>
                      bande {scan.ocrBand}
                    </span>
                  )}
                  {/* Ce que le numéro CONCLUT, pas seulement ce qu'il dit. Sans
                      cette ligne, l'écran affiche « 2/130 » en haut et « 2/130 »
                      dans une ligne plus bas, et laisse comparer les caractères
                      — quatre-vingt-cinq fois de suite. */}
                  {indiceNumero !== null ? (
                    <span className="faint" style={{ fontSize: 11 }}>
                      → candidat {indiceNumero + 1}
                    </span>
                  ) : (
                    scan.candidates.length > 1 && (
                      <span className="faint" style={{ fontSize: 11 }}>
                        ne désigne aucun candidat seul
                      </span>
                    )
                  )}
                </>
              ) : (
                <span className="mono" style={{ color: 'var(--amber)' }}>
                  rien lu — le filtre déterministe n’a pas pu s’appliquer
                </span>
              )}
            </div>

            <section>
              <div className="label" style={{ marginBottom: 'var(--s2)' }}>
                Candidats
              </div>
              {scan?.candidates.length === 0 && (
                <div className="faint" style={{ fontSize: 13 }}>
                  Aucun candidat. Ouvre la recherche avec <kbd>S</kbd>.
                </div>
              )}
              {/* Les images des candidats côte à côte avec le scan. Comparer des
                  NOMS demande de connaître la carte ; comparer des images se fait
                  d'un coup d'oeil — et c'est là que se gagne le budget de
                  3 secondes. */}
              <div style={{ display: 'grid', gap: 4 }}>
                {scan?.candidates.map((c, i) => (
                  <button
                    key={c.card_id}
                    onClick={() => setChosen(i)}
                    className="candidat"
                    data-choisi={i === chosen}
                    data-numero={i === indiceNumero ? 'true' : undefined}
                  >
                    <kbd>{i + 1}</kbd>
                    {c.image ? (
                      /* Survoler agrandit. À 42 px on voit l'illustration, pas
                         le symbole d'extension ni le numéro — et deux
                         réimpressions de la même carte ne se distinguent que
                         par là. */
                      <span className="zoom">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={c.image}
                          alt=""
                          /* PAS `lazy` : ces vignettes sont la décision. `lazy`
                             attend un passage de layout avant même de lancer la
                             requête, sur exactement les images qu'on doit
                             comparer tout de suite. */
                          loading="eager"
                          decoding="async"
                            style={{
                            width: 42,
                            height: 58,
                            objectFit: 'cover',
                            objectPosition: 'top',
                            borderRadius: 3,
                            background: 'var(--surface-2)',
                          }}
                        />
                      </span>
                    ) : (
                      <span
                        style={{
                          width: 42,
                          height: 58,
                          borderRadius: 3,
                          background: 'var(--surface-2)',
                        }}
                      />
                    )}
                    <span style={{ minWidth: 0 }}>
                      <span className="candidat-nom">{c.name}</span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {c.set_name}
                        {c.number && (
                          <span
                            className="mono"
                            style={
                              i === indiceNumero
                                ? { color: 'var(--green)', fontWeight: 600 }
                                : undefined
                            }
                          >
                            {' · '}
                            {c.number}/{c.printedTotal ?? '—'}
                          </span>
                        )}
                      </span>
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--s2)',
                        justifySelf: 'end',
                      }}
                    >
                      {/* Le badge dit POURQUOI cette ligne est choisie. Une
                          sélection sans justification se fait relire à chaque
                          carte, et relire coûte plus cher que décider. */}
                      {i === indiceNumero && <span className="marque">n° lu</span>}
                      <span className="mono faint" style={{ fontSize: 11 }}>
                        {Number(c.distance).toFixed(3)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {searching && (
              <section>
                <div className="label" style={{ marginBottom: 'var(--s2)' }}>
                  Recherche catalogue
                </div>
                <input
                  ref={searchRef}
                  className="input"
                  placeholder="nom de la carte…"
                  style={{ width: '100%' }}
                  onChange={(e) => runSearch(e.target.value)}
                />
                <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                  {hits.map((h) => (
                    <button
                      key={h.card_id}
                      className="btn"
                      style={{ justifyContent: 'flex-start', height: 28 }}
                      onClick={() => {
                        setQueue((q) =>
                          q.map((s) =>
                            s.id === scan?.id
                              ? {
                                  ...s,
                                  candidates: [
                                    {
                                      card_id: h.card_id,
                                      name: h.name,
                                      set_name: h.set_name,
                                      distance: 0,
                                    },
                                    ...s.candidates,
                                  ],
                                }
                              : s,
                          ),
                        );
                        setChosen(0);
                        setSearching(false);
                      }}
                    >
                      {h.name} <span className="dim">{h.set_name}</span>{' '}
                      <span className="mono faint">
                        {h.number}/{h.printed_total ?? '—'}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

          </div>

          {/* Colonne de droite : LES RÉGLAGES ET LES CHIFFRES. Séparés de la
              décision pour que l'œil n'ait pas à faire le tri. */}
          <div className="review-col review-side">
            {/* Deux colonnes fixes plutôt qu'un `flex-wrap` : le retour à la
                ligne dépendait de la largeur restante, si bien que « Prix
                final » passait sous « Variant » ou restait à côté selon la
                fenêtre. Un champ qui change de place d'un écran à l'autre se
                cherche à chaque carte. */}
            <section className="reglages-review">
              {/* Le variant est l'erreur la plus coûteuse : il change de couleur
                  dès qu'il diverge du défaut de session. */}
              <label className="field">
                <span className="label">Variant</span>
                <select
                  className={`select${variantDiverge ? ' select--warn' : ''}`}
                  value={effVariant}
                  onChange={(e) => setVariant(e.target.value as CardVariant)}
                >
                  {variants.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="label">Condition</span>
                <select
                  className="select"
                  value={effCondition}
                  onChange={(e) => setCondition(e.target.value as CardCondition)}
                >
                  {conditions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="label">
                  Prix final <kbd>E</kbd>
                </span>
                <input
                  ref={priceRef}
                  className="input mono"
                  value={priceText}
                  placeholder="—"
                  onChange={(e) => setPriceText(e.target.value)}
                  onBlur={() => setEditing(false)}
                  style={{
                    width: '100%',
                    // Une saisie illisible était ignorée en silence : on croyait
                    // avoir mis un prix et la carte partait sans.
                    borderColor: prixIllisible
                      ? 'var(--red)'
                      : editing
                        ? 'var(--green)'
                        : undefined,
                  }}
                />
              </label>

              <div className="field" style={{ textAlign: 'right' }}>
                <span className="label">
                  Net · port {formatCents(FEES.shippingCents)}
                </span>
                {/* MÊME port que la grille de prix. Cet écran comptait zéro
                    pendant que /pricing comptait un dollar : sur une carte à
                    1,75 $, 1,11 $ contre 0,12 $, deux conclusions opposées. */}
                <span
                  className="num"
                  style={{
                    fontSize: 18,
                    lineHeight: '32px',
                    color: prixIllisible ? 'var(--red)' : undefined,
                  }}
                >
                  {prixIllisible
                    ? 'illisible'
                    : priceCents === null
                      ? '—'
                      : formatCents(
                          netAfterFees(priceCents, FEES.shippingCents, 'ebay').netCents,
                        )}
                </span>
              </div>
            </section>

            <section className="panel" style={{ padding: 'var(--s3)' }}>
              <div className="panel-head">
                {/* « totaux port compris » tenait sur deux lignes dans une
                    colonne de 300 px, et « taux de frais non vérifiés » sur
                    deux autres : quatre lignes d'en-tête au-dessus d'un tableau
                    de quatre. Le port est rappelé dans le champ Net juste
                    au-dessus, le titre n'a pas à le répéter. */}
                <span className="label">Prix · port compris</span>
                {!feesVerified && (
                  <span className="faint" style={{ fontSize: 11 }} title="Les taux de frais eBay et TCGplayer n'ont pas été vérifiés contre une facture réelle.">
                    frais non vérifiés
                  </span>
                )}
              </div>

              {scan?.prices.length === 0 ? (
                <div className="faint" style={{ fontSize: 13 }}>
                  Aucune donnée pour cette carte. Le système ne devine jamais un prix
                  qu&apos;il n&apos;a pas mesuré.
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Moyenne</th>
                      <th>Médiane</th>
                      <th>Min</th>
                      <th>Max</th>
                      <th>n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan?.prices.map((p) => (
                      <tr key={p.source}>
                        <td>
                          {SOURCE_LABEL[p.source] ?? p.source}
                          {p.window_days !== null && (
                            <span className="faint"> · {p.window_days} j</span>
                          )}
                        </td>
                        <td className="num">{p.mid ?? '—'}</td>
                        <td className="mono dim">{p.market ?? '—'}</td>
                        <td className="mono faint">{p.low ?? '—'}</td>
                        <td className="mono faint">{p.high ?? '—'}</td>
                        <td className="mono faint">{p.n_sales ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {soldSales.length > 0 && (
                <div style={{ marginTop: 'var(--s3)' }}>
                  <div className="label">Ventes récentes</div>
                  <div
                    className="mono faint"
                    style={{
                      fontSize: 11,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 'var(--s2)',
                      marginTop: 4,
                    }}
                  >
                    {soldSales.map((v, i) => (
                      <span key={i}>
                        {formatCents(v.total_cents)}
                        {v.vendu_le && <span> ({v.vendu_le.slice(0, 10)})</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {error && <div className="note note--alarm">{error}</div>}
          </div>
        </main>
      </div>

      {/* Les raccourcis restent affichés : un raccourci qu'il faut mémoriser
          sans rappel visuel ne sera pas utilisé. */}
      <footer
        style={{
          display: 'flex',
          gap: 'var(--s4)',
          alignItems: 'center',
          height: 34,
          padding: '0 var(--s4)',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
          fontSize: 11,
          flexShrink: 0,
        }}
        className="dim"
      >
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> naviguer
        </span>
        <span>
          <kbd>1</kbd>–<kbd>5</kbd> candidat
        </span>
        <span>
          <kbd>A</kbd> accepter
        </span>
        <span>
          <kbd>E</kbd> prix
        </span>
        <span>
          <kbd>X</kbd> passer
        </span>
        <span>
          <kbd>S</kbd> rechercher
        </span>
        <span>
          <kbd>R</kbd> écarter
        </span>
        <span>
          <kbd>U</kbd> annuler
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <kbd>?</kbd> aide
        </span>
      </footer>
    </>
  );
}
