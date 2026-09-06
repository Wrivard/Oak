'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { savePricingConfig, triggerPriceRefresh } from './actions.js';
import RulesEditor from './rules-editor.js';
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
 *
 * Les champs vivent dans `RulesEditor` et réécrivent le JSON à chaque
 * modification : le texte reste la source de vérité unique, lue par la preview
 * et par l'enregistrement. Deux états parallèles finiraient par diverger, et
 * diverger ici veut dire publier un prix qu'on n'a pas voulu.
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
   * La dernière version ENREGISTRÉE, pour savoir ce qui ne l'est pas.
   *
   * L'écran modifie la preview en direct, ce qui donne l'impression que le
   * changement est pris. Il ne l'est pas tant qu'on n'a pas appuyé sur
   * Enregistrer, et partir sans le faire perdait le travail sans un mot. Sur
   * l'écran qui décide de tous les prix publiés, c'est le silence qui coûte
   * cher.
   */
  const [enregistre, setEnregistre] = useState(initialConfig);
  const modifie = text !== enregistre;

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

  /**
   * Recharger ou fermer l'onglet avec des règles non enregistrées demande
   * confirmation. Ça ne couvre pas la navigation interne — le routeur de Next
   * ne l'expose pas — mais ça couvre le geste le plus courant, et surtout le
   * plus définitif.
   */
  useEffect(() => {
    if (!modifie) return;
    const avant = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', avant);
    return () => window.removeEventListener('beforeunload', avant);
  }, [modifie]);

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
    const envoye = text;
    const res = await savePricingConfig(envoye);
    setBusy(false);
    // La référence prend le texte ENVOYÉ, pas le texte courant : on a pu
    // continuer à taper pendant l'aller-retour, et ces frappes-là ne sont pas
    // enregistrées.
    if (res.ok) setEnregistre(envoye);
    setSaved(res.ok ? 'enregistré' : (res.error ?? 'échec'));
  }

  /**
   * Rejouer le pricing tout de suite.
   *
   * Le cron passe toutes les heures. Après avoir changé une règle, attendre
   * l'heure suivante pour voir l'effet sur de vraies cartes n'est pas tenable —
   * et l'alternative documentée était d'ouvrir psql pour insérer un job à la
   * main, ce qui n'est pas une interface.
   */
  async function reprixer() {
    setBusy(true);
    setSaved(null);
    const res = await triggerPriceRefresh();
    setBusy(false);
    setSaved(
      res.ok
        ? res.enfile
          ? 'repricing enfilé — le worker s’en occupe'
          : 'un repricing est déjà en file'
        : (res.error ?? 'échec'),
    );
  }

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Règles de prix</h1>
        <span className="page-sub">
          {synthetic ? 'échelle synthétique' : `${rows.length} SKUs réels`}
        </span>
        <div className="page-actions">
          {/* Un point ambre plutôt qu'une phrase : il se voit du coin de l'oeil
              et ne pousse rien. Le bouton Enregistrer passe en vert juste à
              côté, ce qui dit quoi faire sans l'écrire. */}
          {modifie && (
            <span
              className="label"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--amber)',
              }}
            >
              <span className="dot dot--warn" />
              non enregistré
            </span>
          )}
          {saved && !modifie && (
            <span className="dim" style={{ fontSize: 12 }}>
              {saved}
            </span>
          )}
          {/* Voir l'effet d'une règle sur de VRAIES cartes sans attendre le
              cron. On enfile un job, on ne price pas ici : invariant 4. */}
          <button
            className="btn"
            onClick={() => void reprixer()}
            disabled={busy}
            title="Enfile un rafraîchissement des prix ; le worker le traite"
          >
            Reprixer maintenant
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={busy || parsed.cfg === null}
          >
            Enregistrer
          </button>
        </div>
      </header>

      {/* Les largeurs sont en CSS et non en style en ligne : sous 1250 px les
          deux colonnes ne tiennent plus, et une media query ne surcharge pas un
          style en ligne. */}
      <div className="page-body page-body--flush prix-body">
        <section className="prix-regles">
          <div className="prix-defile">
            <RulesEditor cfg={parsed.cfg} error={parsed.error} text={text} onChange={setText} />
          </div>
        </section>

        <section className="prix-apercu">
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

          <div className="cadre">
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
          </div>

          <p className="faint" style={{ fontSize: 11, marginTop: 'var(--s3)' }}>
            Net calculé avec {formatCents(shippingCents)} d&apos;expédition.
            {!feesVerified && ' Taux de frais NON VÉRIFIÉS auprès du Seller Hub.'}
          </p>
        </section>
      </div>
    </>
  );
}
