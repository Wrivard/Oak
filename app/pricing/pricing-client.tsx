'use client';

import { useMemo, useState } from 'react';
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

  // La preview se recalcule à chaque frappe. Si le JSON est cassé, on montre
  // l'erreur et on garde la dernière preview valide plutôt que de vider l'écran.
  const parsed = useMemo(() => {
    try {
      return { cfg: parsePricingConfig(JSON.parse(text)), error: null as string | null };
    } catch (err) {
      return { cfg: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [text]);

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
    <main style={{ display: 'grid', gridTemplateColumns: '460px 1fr', gap: 'var(--s4)', padding: 'var(--s4)', height: '100vh' }}>
      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Règles de prix</h1>
        <p className="dim" style={{ fontSize: 12, marginTop: 'var(--s1)' }}>
          Éditable sans redeploy. Validée avant écriture — une config malformée est
          refusée, pas appliquée.
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="mono"
          style={{
            flex: 1,
            marginTop: 'var(--s3)',
            minHeight: 0,
            resize: 'none',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--text)',
            background: 'var(--bg)',
            border: `1px solid ${parsed.error ? 'var(--red)' : 'var(--border)'}`,
            borderRadius: 'var(--s1)',
            padding: 'var(--s3)',
          }}
        />

        {parsed.error && (
          <pre
            className="mono"
            style={{ color: 'var(--red)', fontSize: 12, whiteSpace: 'pre-wrap', margin: 'var(--s2) 0 0' }}
          >
            {parsed.error}
          </pre>
        )}

        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', marginTop: 'var(--s3)' }}>
          <button
            onClick={() => void save()}
            disabled={busy || parsed.cfg === null}
            style={{
              background: parsed.cfg ? 'var(--green-bg)' : 'var(--surface-2)',
              borderColor: parsed.cfg ? 'var(--green)' : 'var(--border)',
              color: parsed.cfg ? 'var(--green)' : 'var(--text-faint)',
              padding: 'var(--s2) var(--s4)',
            }}
          >
            Enregistrer
          </button>
          {saved && <span className="dim" style={{ fontSize: 12 }}>{saved}</span>}
        </div>
      </section>

      <section style={{ minHeight: 0, overflow: 'auto' }}>
        <div className="label" style={{ marginBottom: 'var(--s2)' }}>
          Preview{' '}
          {synthetic ? (
            <span style={{ color: 'var(--amber)' }}>
              — aucun SKU en stock, échelle synthétique
            </span>
          ) : (
            <span>— {rows.length} SKUs réels</span>
          )}
        </div>

        <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr className="label" style={{ textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: 'var(--s1) var(--s2)' }}>Carte</th>
              <th style={{ padding: 'var(--s1) var(--s2)' }}>Valeur</th>
              <th style={{ padding: 'var(--s1) var(--s2)' }}>Bande</th>
              <th style={{ padding: 'var(--s1) var(--s2)' }}>Prix eBay</th>
              <th style={{ padding: 'var(--s1) var(--s2)' }}>Prix TCG</th>
              <th style={{ padding: 'var(--s1) var(--s2)' }}>Net eBay</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              if (!parsed.cfg) return null;
              const ebay = suggestPrice(r.valueCents, r.condition, parsed.cfg, 'ebay');
              const tcg = suggestPrice(r.valueCents, r.condition, parsed.cfg, 'tcgplayer');
              const net = netAfterFees(ebay.priceCents, shippingCents, 'ebay').netCents;

              return (
                <tr
                  key={`${r.label}-${i}`}
                  style={{
                    borderTop: '1px solid var(--border)',
                    background: i % 2 ? 'var(--surface)' : 'transparent',
                  }}
                >
                  <td style={{ padding: 'var(--s1) var(--s2)' }}>
                    <span style={{ fontFamily: 'var(--font)' }}>{r.label}</span>{' '}
                    <span className="faint" style={{ fontSize: 11 }}>{r.sub}</span>
                  </td>
                  <td style={{ textAlign: 'right', padding: 'var(--s1) var(--s2)' }}>
                    {formatCents(r.valueCents)}
                  </td>
                  <td className="faint" style={{ textAlign: 'right', padding: 'var(--s1) var(--s2)' }}>
                    {ebay.band.mode === 'floor' ? 'plancher' : `×${ebay.band.value}`}
                    {ebay.flagReview && <span style={{ color: 'var(--red)' }}> ⚑</span>}
                  </td>
                  <td style={{ textAlign: 'right', padding: 'var(--s1) var(--s2)' }}>
                    {formatCents(ebay.priceCents)}
                  </td>
                  <td className="dim" style={{ textAlign: 'right', padding: 'var(--s1) var(--s2)' }}>
                    {formatCents(tcg.priceCents)}
                  </td>
                  {/* Le net en direct pendant qu'on bouge le plancher : c'est
                      exactement ce que docs/03 §4 demande de voir avant de
                      décider, pas au payout. */}
                  <td
                    style={{
                      textAlign: 'right',
                      padding: 'var(--s1) var(--s2)',
                      fontWeight: 600,
                      color: net <= 0 ? 'var(--red)' : net < 50 ? 'var(--amber)' : 'var(--green)',
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
          {!feesVerified && ' Taux de frais NON VÉRIFIÉS auprès du Seller Hub — estimation.'}
        </p>
      </section>
    </main>
  );
}
