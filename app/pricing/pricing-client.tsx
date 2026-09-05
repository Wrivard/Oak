'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { savePricingConfig } from './actions.js';
import type { PreviewSku } from './queries.js';
import { formatCents, netAfterFees } from '../../lib/pricing/net.js';
import { parsePricingConfig, suggestPrice } from '../../lib/pricing/rules.js';
import type { CardCondition } from '../../lib/sku.js';

/**
 * Éditeur de règles de prix, avec preview en direct.
 *
 * Le calcul de preview utilise EXACTEMENT `suggestPrice`, la même fonction que
 * le handler `price_refresh`. Une preview qui réimplémenterait la règle
 * mentirait le jour où les deux divergent.
 */
interface Props {
  initialConfig: string;
  skus: PreviewSku[];
  ladder: readonly number[];
  feesVerified: boolean;
  shippingCents: number;
}

interface Row {
  label: string;
  sub: string;
  condition: CardCondition;
  valueCents: number;
  currentCents: number | null;
  synthetic: boolean;
}

export default function PricingClient({
  initialConfig,
  skus,
  ladder,
  feesVerified,
  shippingCents,
}: Props) {
  const [text, setText] = useState(initialConfig);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Texte débouncé pour la preview.
   *
   * Le champ reste évidemment instantané ; c'est le RECALCUL qui attend. Sans
   * ça, chaque frappe reparse le JSON, revalide le schéma et recalcule vingt
   * lignes de prix — et surtout, une accolade à moitié tapée fait clignoter une
   * erreur rouge en permanence pendant qu'on édite.
   */
  const [debounced, setDebounced] = useState(initialConfig);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(t);
  }, [text]);

  const parsed = useMemo(() => {
    try {
      return {
        cfg: parsePricingConfig(JSON.parse(debounced)),
        error: null as string | null,
      };
    } catch (err) {
      return { cfg: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [debounced]);

  /** La dernière config VALIDE, pour ne pas vider le tableau pendant l'édition. */
  const lastGood = useRef(parsed.cfg);
  if (parsed.cfg) lastGood.current = parsed.cfg;
  const previewCfg = parsed.cfg ?? lastGood.current;

  const rows: Row[] = useMemo(() => {
    const real = skus
      .filter((s): s is PreviewSku & { valueCents: number } => s.valueCents !== null)
      .map((s) => ({
        label: s.name,
        sub: `${s.set_name} · ${s.condition}`,
        condition: s.condition,
        valueCents: s.valueCents,
        currentCents: s.currentCents,
        synthetic: false,
      }));
    if (real.length > 0) return real;

    return ladder.map((cents) => ({
      label: formatCents(cents),
      sub: 'valeur synthétique',
      condition: 'NM' as CardCondition,
      valueCents: cents,
      currentCents: null,
      synthetic: true,
    }));
  }, [skus, ladder]);

  const synthetic = rows[0]?.synthetic ?? false;

  async function save() {
    setBusy(true);
    setSaved(null);
    const res = await savePricingConfig(text);
    setBusy(false);
    setSaved(res.ok ? 'enregistré' : (res.error ?? 'échec'));
  }

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Règles de prix</h1>
        <span className="page-sub">
          {synthetic ? 'échelle synthétique' : `${rows.length} SKUs réels`}
        </span>
        <div className="page-actions">
          {saved && <span className="dim" style={{ fontSize: 12 }}>{saved}</span>}
          <button
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={busy || parsed.cfg === null}
          >
            Enregistrer
          </button>
        </div>
      </header>

      <div
        className="page-body page-body--flush"
        style={{ display: 'grid', gridTemplateColumns: '420px 1fr', minHeight: 0 }}
      >
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            padding: 'var(--s4)',
            borderRight: '1px solid var(--border)',
          }}
        >
          <span className="label">Configuration</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="textarea"
            style={{
              flex: 1,
              marginTop: 'var(--s2)',
              minHeight: 0,
              borderColor: parsed.error ? 'var(--red)' : 'var(--border)',
            }}
          />
          {parsed.error && (
            <pre
              className="mono"
              style={{
                color: 'var(--red)',
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                margin: 'var(--s2) 0 0',
                maxHeight: 90,
                overflow: 'auto',
              }}
            >
              {parsed.error}
            </pre>
          )}
          <p className="faint" style={{ fontSize: 11, margin: 'var(--s2) 0 0' }}>
            Validée avant écriture : une config malformée est refusée, pas appliquée.
          </p>
        </section>

        <section style={{ minHeight: 0, overflow: 'auto', padding: 'var(--s4)' }}>
          {synthetic && (
            <div className="note note--warn" style={{ marginBottom: 'var(--s3)' }}>
              Aucun SKU en stock — la preview tourne sur une échelle de valeurs
              synthétiques qui reprend les frontières de bandes.
            </div>
          )}
          {parsed.error && previewCfg && (
            <div className="note note--warn" style={{ marginBottom: 'var(--s3)' }}>
              JSON invalide — la preview montre la dernière configuration valide.
            </div>
          )}

          <table className="table">
            <thead>
              <tr>
                <th>Carte</th>
                <th>Valeur</th>
                <th>Bande</th>
                <th>Prix eBay</th>
                <th>Prix TCG</th>
                <th>Net eBay</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                if (!previewCfg) return null;
                const ebay = suggestPrice(r.valueCents, r.condition, previewCfg, 'ebay');
                const tcg = suggestPrice(r.valueCents, r.condition, previewCfg, 'tcgplayer');
                const net = netAfterFees(ebay.priceCents, shippingCents, 'ebay').netCents;

                return (
                  <tr key={`${r.label}-${i}`}>
                    <td>
                      {r.label}{' '}
                      <span className="faint" style={{ fontSize: 11 }}>
                        {r.sub}
                      </span>
                    </td>
                    <td className="mono">{formatCents(r.valueCents)}</td>
                    <td className="mono faint">
                      {ebay.band.mode === 'floor' ? 'plancher' : `×${ebay.band.value}`}
                      {ebay.flagReview && <span style={{ color: 'var(--red)' }}> ⚑</span>}
                    </td>
                    <td className="mono">{formatCents(ebay.priceCents)}</td>
                    <td className="mono dim">{formatCents(tcg.priceCents)}</td>
                    {/* Le net en direct pendant qu'on bouge le plancher :
                        docs/03 §4 veut ce chiffre AVANT de décider. */}
                    <td
                      className="num"
                      style={{
                        color:
                          net <= 0
                            ? 'var(--red)'
                            : net < 50
                              ? 'var(--amber)'
                              : 'var(--green)',
                      }}
                    >
                      {formatCents(net)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="faint" style={{ fontSize: 11, marginTop: 'var(--s3)' }}>
            Net calculé avec {formatCents(shippingCents)} d&apos;expédition.
            {!feesVerified && ' Taux de frais NON VÉRIFIÉS auprès du Seller Hub.'}
          </p>
        </section>
      </div>
    </>
  );
}
