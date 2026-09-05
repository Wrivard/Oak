'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmScan, searchCatalog, type SearchHit } from './actions.js';
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

  /** Confirmation visuelle brève : on doit SAVOIR que l'appui a été pris. */
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 160);
    return () => clearTimeout(t);
  }, [flash]);

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
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accept, move, scan, undo]);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem('review.sound', next ? '1' : '0');
    } catch {
      // Préférence de confort : si le stockage refuse, l'état vit pour la session.
    }
  }

  if (queue.length === 0) {
    return (
      <main style={{ padding: 'var(--s6)' }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>File de review vide</h1>
        <p className="dim" style={{ marginTop: 'var(--s2)' }}>
          Aucun scan en <span className="mono">needs_review</span>. Tout ce qui est entré
          a été résolu par les niveaux 1 et 2.
        </p>
      </main>
    );
  }

  const priceCents = priceText === '' ? null : parseAmount(priceText);
  const secPerCard = treated === 0 ? 0 : (Date.now() - startedAt.current) / 1000 / treated;
  const soldSales = scan?.prices.find((p) => p.source === 'ebay_sold')?.sales ?? [];

  return (
    <div style={{ display: 'grid', gridTemplateRows: '1fr auto', height: '100vh' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: 0 }}>
        {/* File compacte : 32 px par ligne (docs/06 §4). */}
        <aside
          style={{
            borderRight: '1px solid var(--border)',
            overflowY: 'auto',
            background: 'var(--surface)',
          }}
        >
          <div className="label" style={{ padding: 'var(--s2) var(--s3)' }}>
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
                justifyContent: 'space-between',
                gap: 'var(--s2)',
                width: '100%',
                height: 32,
                alignItems: 'center',
                padding: '0 var(--s3)',
                border: 'none',
                borderLeft: `2px solid ${i === cursor ? 'var(--green)' : 'transparent'}`,
                borderRadius: 0,
                background: i === cursor ? 'var(--surface-2)' : 'transparent',
                textAlign: 'left',
              }}
            >
              <span className="mono" style={{ fontSize: 12 }}>
                #{s.seq}
              </span>
              <span className="faint" style={{ fontSize: 11, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {s.candidates[0]?.name ?? 'inconnue'}
              </span>
              {s.variant_conflict && <span style={{ color: 'var(--red)', fontSize: 11 }}>!</span>}
            </button>
          ))}
        </aside>

        {/* La carte en cours reste à une position fixe : c'est la file qui
            défile derrière, pas la carte qui saute (docs/06 §5). */}
        <main
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(240px, 340px) 1fr',
            gap: 'var(--s4)',
            padding: 'var(--s4)',
            minHeight: 0,
            overflow: 'auto',
          }}
        >
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/scan/${scan?.id}/image`}
              alt={`scan #${scan?.seq}`}
              style={{
                width: '100%',
                borderRadius: 'var(--s2)',
                border: `2px solid ${flash ? 'var(--green)' : TIER_COLOR[tier]}`,
                background: 'var(--surface)',
                // Assez rapide pour ne pas retarder la carte suivante, assez
                // visible pour confirmer l'appui.
                transition: 'border-color 120ms ease-out, opacity 120ms ease-out',
                opacity: flash ? 0.55 : 1,
              }}
            />
            <div className="label mono" style={{ marginTop: 'var(--s2) ' }}>
              {scan?.session_name} · #{scan?.seq}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s3)', minWidth: 0 }}>
            {scan?.variant_conflict && (
              <div
                style={{
                  border: '1px solid var(--red)',
                  borderRadius: 'var(--s2)',
                  padding: 'var(--s2) var(--s3)',
                  color: 'var(--red)',
                  fontSize: 13,
                }}
              >
                Conflit de variant — une empreinte connue de cette carte a un variant
                différent du défaut de session. Vérifie avant d&apos;accepter.
              </div>
            )}

            <section>
              <div className="label">Candidats</div>
              {scan?.candidates.length === 0 && (
                <div className="faint" style={{ padding: 'var(--s2) 0' }}>
                  Aucun candidat. Ouvre la recherche avec <kbd>S</kbd>.
                </div>
              )}
              {scan?.candidates.map((c, i) => (
                <button
                  key={c.card_id}
                  onClick={() => setChosen(i)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '20px 1fr auto',
                    gap: 'var(--s2)',
                    alignItems: 'center',
                    width: '100%',
                    textAlign: 'left',
                    marginTop: 'var(--s1)',
                    padding: 'var(--s2)',
                    background: i === chosen ? 'var(--green-bg)' : 'var(--surface)',
                    borderColor: i === chosen ? 'var(--green)' : 'var(--border)',
                  }}
                >
                  <kbd>{i + 1}</kbd>
                  <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    <strong>{c.name}</strong> <span className="dim">{c.set_name}</span>
                  </span>
                  <span className="mono faint" style={{ fontSize: 12 }}>
                    {Number(c.distance).toFixed(3)}
                  </span>
                </button>
              ))}
            </section>

            {searching && (
              <section>
                <div className="label">Recherche catalogue</div>
                <input
                  ref={searchRef}
                  placeholder="nom de la carte…"
                  style={{ width: '100%' }}
                  onChange={(e) => void runSearch(e.target.value)}
                />
                {hits.map((h) => (
                  <button
                    key={h.card_id}
                    onClick={() => {
                      // Remplace le candidat choisi par le résultat retenu.
                      setQueue((q) =>
                        q.map((s) =>
                          s.id === scan?.id
                            ? {
                                ...s,
                                candidates: [
                                  { card_id: h.card_id, name: h.name, set_name: h.set_name, distance: 0 },
                                  ...s.candidates,
                                ],
                              }
                            : s,
                        ),
                      );
                      setChosen(0);
                      setSearching(false);
                    }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 'var(--s1)' }}
                  >
                    {h.name} <span className="dim">{h.set_name}</span>{' '}
                    <span className="mono faint">
                      {h.number}/{h.printed_total ?? '—'}
                    </span>
                  </button>
                ))}
              </section>
            )}

            {/* Le variant est l'erreur la plus coûteuse : 5 à 20x d'écart de
                prix. Il est en haut, en gras, et change de couleur s'il diverge
                du défaut de session. */}
            <section style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 'var(--s1)' }}>
                <span className="label">Variant</span>
                <select
                  value={effVariant}
                  onChange={(e) => setVariant(e.target.value as CardVariant)}
                  style={{
                    fontWeight: 600,
                    borderColor:
                      effVariant !== scan?.default_variant ? 'var(--amber)' : 'var(--border)',
                    color: effVariant !== scan?.default_variant ? 'var(--amber)' : 'var(--text)',
                  }}
                >
                  {variants.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'grid', gap: 'var(--s1)' }}>
                <span className="label">Condition</span>
                <select
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

              <label style={{ display: 'grid', gap: 'var(--s1)' }}>
                <span className="label">
                  Prix final <kbd>E</kbd>
                </span>
                <input
                  ref={priceRef}
                  className="mono"
                  value={priceText}
                  placeholder="—"
                  onChange={(e) => setPriceText(e.target.value)}
                  onBlur={() => setEditing(false)}
                  style={{ width: 100, borderColor: editing ? 'var(--green)' : 'var(--border)' }}
                />
              </label>
            </section>

            <section>
              <div className="label">Sources de prix — totaux prix + port</div>
              {scan?.prices.length === 0 ? (
                <div className="faint" style={{ padding: 'var(--s2) 0', fontSize: 13 }}>
                  Aucune donnée de prix pour cette carte. Le système ne devine jamais un
                  prix qu&apos;il n&apos;a pas mesuré.
                </div>
              ) : (
                <table className="mono" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr className="label" style={{ textAlign: 'right' }}>
                      <th style={{ textAlign: 'left', padding: '2px var(--s2)' }}>Source</th>
                      <th style={{ padding: '2px var(--s2)' }}>Moyenne</th>
                      <th style={{ padding: '2px var(--s2)' }}>Médiane</th>
                      <th style={{ padding: '2px var(--s2)' }}>Min</th>
                      <th style={{ padding: '2px var(--s2)' }}>Max</th>
                      <th style={{ padding: '2px var(--s2)' }}>n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan?.prices.map((p) => (
                      <tr key={p.source} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '2px var(--s2)' }}>
                          {SOURCE_LABEL[p.source] ?? p.source}
                          {p.window_days !== null && (
                            <span className="faint"> · {p.window_days} j</span>
                          )}
                        </td>
                        {/* La MOYENNE est le chiffre demandé. La MÉDIANE est à
                            côté parce qu'un écart entre les deux signale du bruit
                            dans la recherche : un lot, une carte gradée. */}
                        <td style={{ textAlign: 'right', padding: '2px var(--s2)', fontWeight: 600 }}>
                          {p.mid ?? '—'}
                        </td>
                        <td style={{ textAlign: 'right', padding: '2px var(--s2)' }} className="dim">
                          {p.market ?? '—'}
                        </td>
                        <td style={{ textAlign: 'right', padding: '2px var(--s2)' }} className="faint">
                          {p.low ?? '—'}
                        </td>
                        <td style={{ textAlign: 'right', padding: '2px var(--s2)' }} className="faint">
                          {p.high ?? '—'}
                        </td>
                        <td style={{ textAlign: 'right', padding: '2px var(--s2)' }} className="faint">
                          {p.n_sales ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Les ventes passées, avec leurs dates : c'est ce qui dit si le
                  prix tient encore ou s'il date de trois mois. */}
              {soldSales.length > 0 && (
                <div style={{ marginTop: 'var(--s2)' }}>
                  <div className="label">Ventes récentes</div>
                  <div className="mono faint" style={{ fontSize: 11, display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
                    {soldSales.map((v, i) => (
                      <span key={i}>
                        {formatCents(v.total_cents)}
                        {v.vendu_le && (
                          <span className="faint"> ({v.vendu_le.slice(0, 10)})</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* net_after_fees affiché en permanence (docs/03 §4). */}
            <section
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--s2)',
                padding: 'var(--s3)',
              }}
            >
              <div className="label">Net après frais eBay</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {priceCents === null
                  ? '—'
                  : formatCents(netAfterFees(priceCents, 0, 'ebay').netCents)}
              </div>
              {!feesVerified && (
                <div className="faint" style={{ fontSize: 11, marginTop: 'var(--s1)' }}>
                  Estimation : taux de frais non vérifiés auprès du Seller Hub.
                </div>
              )}
            </section>

            {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
          </div>
        </main>
      </div>

      {/* Les raccourcis restent affichés : un raccourci qu'il faut mémoriser sans
          rappel visuel ne sera pas utilisé (docs/06 §6). */}
      <footer
        style={{
          display: 'flex',
          gap: 'var(--s4)',
          alignItems: 'center',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: 'var(--s2) var(--s4)',
          fontSize: 12,
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
          <kbd>U</kbd> annuler
        </span>

        {/* La cadence réelle, en direct. C'est le seul chiffre qui dit si le
            budget de 3 secondes par carte est tenu — et le voir bouger rend la
            session mesurable au lieu d'interminable. */}
        <span style={{ marginLeft: 'auto' }} className="mono">
          {treated > 0 && (
            <>
              {treated} traitées ·{' '}
              <span style={{ color: secPerCard <= 3 ? 'var(--green)' : 'var(--amber)' }}>
                {secPerCard.toFixed(1)} s/carte
              </span>
              {' · '}
            </>
          )}
          {queue.length} restantes
        </span>

        <button onClick={toggleSound}>son {sound ? 'on' : 'off'}</button>
        {inFlight > 0 && (
          <span className="mono faint" title="écritures en cours">
            ⟳{inFlight}
          </span>
        )}
      </footer>
    </div>
  );
}
