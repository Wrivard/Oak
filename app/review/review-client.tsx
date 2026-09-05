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
import { formatCents, netAfterFees, parseAmount } from '../../lib/pricing/net.js';
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
  const [chosen, setChosen] = useState(0);
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

  useEffect(() => {
    try {
      setSound(localStorage.getItem('review.sound') === '1');
    } catch {
      // Mode privé ou stockage bloqué : le son reste coupé, c'est le défaut.
    }
  }, []);

  // Réinitialise l'édition à chaque changement de carte : garder un prix saisi
  // d'une carte sur l'autre est le meilleur moyen de mal étiqueter une pile.
  useEffect(() => {
    setChosen(0);
    setVariant(null);
    setCondition(null);
    setPriceText('');
    setEditing(false);
    setSearching(false);
    setHits([]);
    setError(null);
  }, [cursor]);

  const tier = useMemo(() => tierOf(scan?.valueCents ?? null, thresholds), [scan, thresholds]);

  /**
   * Préchargement des voisines.
   *
   * Sans ça, chaque flèche déclenche un téléchargement à froid et l'image
   * apparaît après coup. Les deux suivantes et la précédente suffisent : on ne
   * navigue jamais plus vite que ça, et précharger toute la file gaspillerait la
   * bande passante sur des cartes qu'on ne verra pas.
   */
  useEffect(() => {
    for (const offset of [1, 2, -1]) {
      const neighbour = queue[cursor + offset];
      if (!neighbour) continue;
      const img = new Image();
      img.src = `/api/scan/${neighbour.id}/image`;
    }
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
   * Réapprovisionnement automatique.
   *
   * On recharge quand il reste moins de 40 cartes, pas quand la file est vide :
   * le chargement doit être fini AVANT qu'on en ait besoin, sinon on attend, et
   * attendre est précisément ce qu'on cherche à supprimer.
   */
  const refilling = useRef(false);
  useEffect(() => {
    if (refilling.current || queue.length >= 40) return;
    refilling.current = true;
    void loadMore(queue.map((s) => s.id))
      .then((more) => {
        if (more.length > 0) setQueue((q) => [...q, ...more]);
      })
      .catch((err: unknown) => setError(`chargement de la suite : ${String(err)}`))
      .finally(() => {
        refilling.current = false;
      });
  }, [queue]);

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

      <div
        className="page-body page-body--flush"
        style={{ display: 'grid', gridTemplateColumns: '200px 1fr', minHeight: 0 }}
      >
        {/* File compacte : 30 px par ligne. On en voit le plus possible sans que
            les cibles deviennent difficiles à viser. */}
        <aside
          style={{
            overflowY: 'auto',
            borderRight: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <div className="label" style={{ padding: 'var(--s3) var(--s3) var(--s2)' }}>
            {queue.length} en attente
          </div>
          {queue.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => {
                if (el) rowRefs.current.set(s.id, el);
                else rowRefs.current.delete(s.id);
              }}
              onClick={() => setCursor(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s2)',
                width: '100%',
                height: 30,
                padding: '0 var(--s3)',
                border: 'none',
                borderLeft: `2px solid ${i === cursor ? 'var(--green)' : 'transparent'}`,
                background: i === cursor ? 'var(--surface-2)' : 'transparent',
                color: i === cursor ? 'var(--text)' : 'var(--text-dim)',
                textAlign: 'left',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 12,
              }}
            >
              <span className="mono faint" style={{ fontSize: 11 }}>
                {s.seq}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
              >
                {s.candidates[0]?.name ?? 'inconnue'}
              </span>
              {s.variant_conflict && <span className="dot dot--alarm" />}
            </button>
          ))}
        </aside>

        <main className="review-grid">
          <div>
            {imageManquante ? (
              <div
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  gap: 'var(--s2)',
                  aspectRatio: '5 / 7',
                  padding: 'var(--s4)',
                  textAlign: 'center',
                  borderRadius: 'var(--r3)',
                  border: '2px dashed var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-faint)',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>Image indisponible</span>
                <span style={{ fontSize: 11 }}>
                  Le fichier a été déplacé ou purgé. Les candidats et le numéro lu
                  restent exploitables.
                </span>
              </div>
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/scan/${scan?.id}/image`}
                  alt={`scan ${scan?.seq}`}
                  onError={() => setImageManquante(true)}
                  style={{
                    width: '100%',
                    borderRadius: 'var(--r3)',
                    border: `2px solid ${flash ? 'var(--green)' : TIER_COLOR[tier]}`,
                    background: 'var(--surface)',
                    transition: 'border-color 120ms ease-out, opacity 120ms ease-out',
                    opacity: flash ? 0.5 : 1,
                  }}
                />
                <a
                  href={`/api/scan/${scan?.id}/image?full=1`}
                  target="_blank"
                  rel="noreferrer"
                  className="faint"
                  style={{ fontSize: 11, display: 'block', marginTop: 6 }}
                >
                  voir en pleine résolution
                </a>
              </>
            )}
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
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '20px 42px 1fr auto',
                      gap: 'var(--s2)',
                      alignItems: 'center',
                      width: '100%',
                      textAlign: 'left',
                      padding: '5px var(--s2)',
                      font: 'inherit',
                      fontSize: 13,
                      color: 'var(--text)',
                      cursor: 'pointer',
                      background: i === chosen ? 'var(--green-bg)' : 'var(--surface)',
                      border: `1px solid ${i === chosen ? 'var(--green-border)' : 'var(--border)'}`,
                      borderRadius: 'var(--r2)',
                    }}
                  >
                    <kbd>{i + 1}</kbd>
                    {c.image ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={c.image}
                        alt=""
                        loading="lazy"
                        style={{
                          width: 42,
                          height: 58,
                          objectFit: 'cover',
                          objectPosition: 'top',
                          borderRadius: 3,
                          background: 'var(--surface-2)',
                        }}
                      />
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
                      <span
                        style={{
                          display: 'block',
                          fontWeight: 500,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {c.name}
                      </span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {c.set_name}
                        {c.number && (
                          <span className="mono">
                            {' · '}
                            {c.number}/{c.printedTotal ?? '—'}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="mono faint" style={{ fontSize: 11 }}>
                      {Number(c.distance).toFixed(3)}
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
            <section style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap' }}>
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
                  style={{ width: 100, borderColor: editing ? 'var(--green)' : undefined }}
                />
              </label>

              <div className="field" style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <span className="label">Net après frais</span>
                <span className="num" style={{ fontSize: 18, lineHeight: '32px' }}>
                  {priceCents === null
                    ? '—'
                    : formatCents(netAfterFees(priceCents, 0, 'ebay').netCents)}
                </span>
              </div>
            </section>

            <section className="panel" style={{ padding: 'var(--s3)' }}>
              <div className="panel-head">
                <span className="label">Prix — totaux port compris</span>
                {!feesVerified && (
                  <span className="faint" style={{ fontSize: 11 }}>
                    taux de frais non vérifiés
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
