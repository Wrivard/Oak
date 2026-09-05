'use client';

import { useState } from 'react';
import type { PricingConfig } from '../../lib/pricing/rules.js';
import {
  ajouterBande,
  changerBorne,
  changerMode,
  retirerBande,
} from '../../lib/pricing/edit.js';
import { formatCents } from '../../lib/pricing/net.js';

/**
 * L'éditeur de règles, en vrais champs.
 *
 * Cette config décide du prix de 12 à 15 000 SKUs. Elle était éditable dans un
 * bloc JSON brut : c'est-à-dire qu'on ne pouvait pas changer un plancher sans
 * risquer une virgule, et qu'il fallait connaître le schéma par cœur pour
 * savoir ce qui était réglable. Un écran d'outil, pas un écran d'application.
 *
 * Le JSON reste la SOURCE DE VÉRITÉ — les champs le réécrivent à chaque
 * frappe, la preview et l'enregistrement continuent de le lire. Deux états
 * parallèles finiraient par diverger, et diverger ici veut dire publier un prix
 * qu'on n'a pas voulu.
 *
 * Il reste accessible en bas, replié : c'est la sortie de secours quand on veut
 * coller une config entière, et le seul endroit où voir ce qui sera écrit.
 */
interface Props {
  cfg: PricingConfig | null;
  /** Erreur de parse. Quand elle est là, les champs ne peuvent rien éditer. */
  error: string | null;
  text: string;
  onChange: (next: string) => void;
}

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
const CANAUX = [
  ['ebay', 'eBay'],
  ['tcgplayer', 'TCGplayer'],
] as const;

function serialise(cfg: PricingConfig): string {
  return JSON.stringify(cfg, null, 2);
}

/**
 * Champ numérique qui ne se bat pas avec la frappe.
 *
 * Un `<input type="number">` lié directement à un nombre efface ce qu'on tape
 * dès que la valeur intermédiaire est invalide — taper « 1. » avant « 1.5 »
 * remet le champ à zéro. On garde donc le texte tant que le champ a le focus.
 */
function NumField({
  label,
  value,
  onCommit,
  step = '0.01',
  suffix,
  width,
}: {
  label?: string;
  value: number;
  onCommit: (n: number) => void;
  step?: string;
  suffix?: string;
  width?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);

  return (
    <label className="field" style={width ? { width } : undefined}>
      {label && <span className="label">{label}</span>}
      <span style={{ position: 'relative', display: 'block' }}>
        <input
          className="input mono"
          inputMode="decimal"
          step={step}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            // Une saisie qui ne fait pas un nombre ne devient pas zéro : elle
            // est abandonnée. Zéro serait un prix, et un prix faux.
            if (draft !== null && draft.trim() !== '' && Number.isFinite(n)) onCommit(n);
            setDraft(null);
          }}
          style={suffix ? { paddingRight: 26 } : undefined}
        />
        {suffix && (
          <span
            className="faint"
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11,
              pointerEvents: 'none',
            }}
          >
            {suffix}
          </span>
        )}
      </span>
    </label>
  );
}

export default function RulesEditor({ cfg, error, text, onChange }: Props) {
  const [jsonOuvert, setJsonOuvert] = useState(false);

  /**
   * Toute modification passe par ici : on réécrit le JSON, jamais un état
   * parallèle.
   *
   * On repart du TEXTE, pas de l'objet validé : zod retire les clés qu'il ne
   * connaît pas, et repartir de sa sortie ferait disparaître en silence une clé
   * ajoutée à la main dès la première frappe dans un champ.
   */
  const patch = (f: (draft: PricingConfig) => void): void => {
    if (!cfg) return;
    let next: PricingConfig;
    try {
      next = JSON.parse(text) as PricingConfig;
    } catch {
      next = JSON.parse(JSON.stringify(cfg)) as PricingConfig;
    }
    f(next);
    onChange(serialise(next));
  };

  /** Les opérations sur les bandes portent un invariant : elles sont testées. */
  const remplacer = (next: PricingConfig): void => onChange(serialise(next));

  if (!cfg) {
    return (
      <div className="note note--alarm">
        <strong>Configuration illisible.</strong> Corrige le JSON ci-dessous pour
        retrouver les champs.
        <pre
          className="mono"
          style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 'var(--s2) 0 0' }}
        >
          {error}
        </pre>
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="textarea"
          style={{ marginTop: 'var(--s2)', minHeight: 220, borderColor: 'var(--red)' }}
        />
      </div>
    );
  }

  const bandes = cfg.bands;

  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <section className="panel">
        <div className="panel-head">
          <span className="label">Plancher dur</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'flex-end' }}>
          <NumField
            value={cfg.hard_floor}
            width={110}
            suffix="$"
            onCommit={(n) => patch((d) => { d.hard_floor = Math.max(0, n); })}
          />
          <p className="faint" style={{ fontSize: 11, margin: 0, flex: 1 }}>
            Rien n&apos;est jamais publié sous ce prix, quelle que soit la valeur
            estimée. C&apos;est ce qui empêche de vendre à perte une carte que le
            marché price à 8 ¢.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="label">Bandes de prix</span>
          <button
            className="btn btn--ghost"
            onClick={() => remplacer(ajouterBande(cfg))}
          >
            Ajouter une bande
          </button>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <div
            className="label"
            style={{
              display: 'grid',
              gridTemplateColumns: '96px 108px 96px 96px 1fr 28px',
              gap: 'var(--s2)',
              alignItems: 'center',
            }}
          >
            <span>Jusqu&apos;à</span>
            <span>Mode</span>
            <span>Valeur</span>
            <span>Arrondi</span>
            <span>Review</span>
            <span />
          </div>

          {bandes.map((b, i) => {
            const derniere = i === bandes.length - 1;
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '96px 108px 96px 96px 1fr 28px',
                  gap: 'var(--s2)',
                  alignItems: 'center',
                }}
              >
                {derniere ? (
                  <span className="mono faint" style={{ fontSize: 12 }}>
                    au-delà
                  </span>
                ) : (
                  <NumField
                    value={b.up_to ?? 0}
                    suffix="$"
                    onCommit={(n) => remplacer(changerBorne(cfg, i, n))}
                  />
                )}

                <select
                  className="select"
                  value={b.mode}
                  onChange={(e) =>
                    remplacer(changerMode(cfg, i, e.target.value as 'floor' | 'mult'))
                  }
                >
                  <option value="mult">multiplier</option>
                  <option value="floor">plancher</option>
                </select>

                <NumField
                  value={b.value}
                  suffix={b.mode === 'floor' ? '$' : '×'}
                  onCommit={(n) =>
                    patch((d) => {
                      const cible = d.bands[i];
                      if (cible) cible.value = Math.max(0.01, n);
                    })
                  }
                />

                <select
                  className="select"
                  value={b.round ?? 'aucun'}
                  onChange={(e) =>
                    patch((d) => {
                      const cible = d.bands[i];
                      if (!cible) return;
                      const v = e.target.value;
                      // `exactOptionalPropertyTypes` : on SUPPRIME la clé, on ne
                      // l'assigne pas à undefined.
                      if (v === 'aucun') delete cible.round;
                      else cible.round = v as 'psych' | 'whole';
                    })
                  }
                >
                  <option value="psych">,49 / ,99</option>
                  <option value="whole">dollar</option>
                  <option value="aucun">aucun</option>
                </select>

                <label
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={b.flag_review === true}
                    onChange={(e) =>
                      patch((d) => {
                        const cible = d.bands[i];
                        if (!cible) return;
                        if (e.target.checked) cible.flag_review = true;
                        else delete cible.flag_review;
                      })
                    }
                    style={{ accentColor: 'var(--green)' }}
                  />
                  <span className="dim">à valider avant publication</span>
                </label>

                {derniere ? (
                  <span
                    className="faint"
                    title="La dernière bande n’a pas de plafond : sans elle, une carte chère ne tomberait dans aucune bande."
                    style={{ fontSize: 14, textAlign: 'center', cursor: 'help' }}
                  >
                    ∞
                  </span>
                ) : (
                  <button
                    className="btn btn--ghost"
                    title="Retirer cette bande"
                    onClick={() => remplacer(retirerBande(cfg, i))}
                    style={{ padding: '2px 6px', lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <p className="faint" style={{ fontSize: 11, margin: 'var(--s3) 0 0' }}>
          La bande est choisie sur la valeur <strong>ajustée par la condition</strong>,
          avant l&apos;offset de canal — sinon une même carte changerait de bande
          selon qu&apos;on la publie sur eBay ou sur TCGplayer.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="label">Condition</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap' }}>
          {CONDITIONS.map((c) => {
            const v = cfg.condition_mult[c];
            if (v === undefined) return null;
            return (
              <NumField
                key={c}
                label={c}
                value={v}
                width={78}
                suffix="×"
                onCommit={(n) =>
                  patch((d) => { d.condition_mult[c] = Math.max(0.01, n); })
                }
              />
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="label">Canal</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap' }}>
          {CANAUX.map(([k, label]) => {
            const v = cfg.channel_offsets[k];
            if (v === undefined) return null;
            return (
              <NumField
                key={k}
                label={label}
                value={v}
                width={104}
                suffix="×"
                onCommit={(n) =>
                  patch((d) => { d.channel_offsets[k] = Math.max(0.01, n); })
                }
              />
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="label">Garde-fous</span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <NumField
            label="Review au-dessus de"
            value={cfg.review_threshold}
            width={132}
            suffix="$"
            onCommit={(n) => patch((d) => { d.review_threshold = Math.max(0, n); })}
          />
          <NumField
            label="Reprix si écart >"
            value={cfg.reprice_delta_pct}
            width={132}
            step="0.01"
            onCommit={(n) =>
              patch((d) => { d.reprice_delta_pct = Math.min(1, Math.max(0, n)); })
            }
          />
          <label
            style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', paddingBottom: 6 }}
          >
            <input
              type="checkbox"
              checked={cfg.graded_bypass}
              onChange={(e) => patch((d) => { d.graded_bypass = e.target.checked; })}
              style={{ accentColor: 'var(--green)' }}
            />
            <span>Les gradées échappent aux bandes</span>
          </label>
        </div>
        <p className="faint" style={{ fontSize: 11, margin: 'var(--s3) 0 0' }}>
          Une carte estimée au-dessus de {formatCents(Math.round(cfg.review_threshold * 100))}{' '}
          passe par la review avant publication. Le reprix ne se déclenche qu&apos;au-delà
          de {(cfg.reprice_delta_pct * 100).toFixed(0)} % d&apos;écart : sans ce seuil, on
          republierait tout l&apos;inventaire à chaque rafraîchissement pour deux cents.
        </p>
      </section>

      <section className="panel">
        <button
          className="btn btn--ghost"
          onClick={() => setJsonOuvert((v) => !v)}
          style={{ width: '100%', justifyContent: 'space-between' }}
        >
          <span className="label">JSON</span>
          <span className="faint">{jsonOuvert ? 'masquer' : 'afficher'}</span>
        </button>
        {jsonOuvert && (
          <>
            <textarea
              value={text}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              className="textarea"
              style={{ marginTop: 'var(--s3)', minHeight: 260 }}
            />
            <p className="faint" style={{ fontSize: 11, margin: 'var(--s2) 0 0' }}>
              Sortie de secours : coller une config entière, ou voir exactement ce qui
              sera écrit. Validée avant écriture — une config malformée est refusée,
              pas appliquée.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
