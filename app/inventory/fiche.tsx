'use client';

import { useEffect } from 'react';
import { formatCents } from '../../lib/pricing/net.js';
import type { InventoryRow } from './queries.js';
import { useAvis } from '../shell/toast.js';

/**
 * La fiche d'un SKU, en panneau latéral.
 *
 * Le tableau montre un montant et une ligne « non prixé ⓘ ». La question
 * suivante est toujours la même — « d'où sort ce chiffre », ou « pourquoi il
 * n'y en a pas » — et il n'existait aucun endroit pour y répondre : la raison
 * vivait dans un attribut `title` qu'il fallait survoler ligne par ligne, la
 * méthode de calcul était lue en base et jetée, et l'état des canaux tenait
 * dans deux étiquettes de trois lettres.
 *
 * Tout ce qu'elle affiche est DÉJÀ chargé par la ligne du tableau : ouvrir la
 * fiche ne coûte pas une requête. C'est ce qui permet de l'ouvrir d'un clic
 * sans y réfléchir.
 *
 * Elle est en LECTURE SEULE. Modifier une condition ou un variant change le
 * SKU — `{card_id}-{variant}-{condition}-{lang}` — donc déplace une quantité
 * d'une ligne d'inventaire à une autre. Ce n'est pas une édition de champ,
 * c'est un mouvement de stock, et ça ne se met pas derrière un champ de
 * formulaire dans un panneau qu'on ouvre par curiosité.
 */
export default function Fiche({
  row,
  onFermer,
}: {
  row: InventoryRow | null;
  onFermer: () => void;
}) {
  const { avis } = useAvis();

  useEffect(() => {
    if (row === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onFermer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onFermer]);

  if (row === null) return null;

  const copierSku = (): void => {
    // Le SKU sert à chercher la carte dans TCGplayer ou dans un tableur : il
    // est fait pour être collé ailleurs, pas relu à l'écran.
    void navigator.clipboard
      ?.writeText(row.sku)
      .then(() => avis('ok', 'SKU copié', row.sku))
      .catch(() => avis('warn', 'Copie impossible', 'Le navigateur a refusé l’accès au presse-papiers.'));
  };

  return (
    <div className="fiche-fond" onMouseDown={onFermer} role="presentation">
      <aside
        className="fiche"
        role="dialog"
        aria-modal="true"
        aria-label={`${row.name} — ${row.sku}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="fiche-tete">
          <span className="label">Fiche SKU</span>
          <button className="btn btn--ghost btn--sm" onClick={onFermer} title="Fermer (Échap)">
            Fermer
          </button>
        </header>

        <div className="fiche-corps">
          {row.image !== null && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={row.image} alt="" className="fiche-image" />
          )}

          <div>
            <div className="fiche-nom">{row.name}</div>
            <div className="faint" style={{ fontSize: 12 }}>
              {row.set_name} · {row.variant} · {row.condition}
            </div>
          </div>

          <button className="fiche-sku" onClick={copierSku} title="Copier le SKU">
            <span className="mono">{row.sku}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V6a1 1 0 0 1 1-1h9" strokeLinecap="round" />
            </svg>
          </button>

          <dl className="fiche-champs">
            <Champ nom="En stock">
              <span className="num">{row.qty_on_hand}</span>
              {row.qty_reserved_tcg > 0 && (
                <span className="faint"> dont {row.qty_reserved_tcg} réservées TCGplayer</span>
              )}
            </Champ>

            <Champ nom="Valeur estimée">
              {row.valueCents === null ? (
                <span className="faint">—</span>
              ) : (
                <span className="num">{formatCents(row.valueCents)}</span>
              )}
            </Champ>

            <Champ nom="Prix publié">
              {row.priceCents === null ? (
                <span style={{ color: 'var(--amber)' }}>non prixé</span>
              ) : (
                <span className="num">{formatCents(row.priceCents)}</span>
              )}
            </Champ>

            {/* LA question de cet écran. Elle vivait dans un `title`. */}
            {row.priceReason !== null && (
              <Champ nom="Pourquoi">
                <span style={{ color: 'var(--text-dim)' }}>{row.priceReason}</span>
              </Champ>
            )}

            {row.priceMethod !== null && row.priceCents !== null && (
              <Champ nom="Méthode">
                <span className="mono faint">{row.priceMethod}</span>
              </Champ>
            )}

            <Champ nom="Dernier prix calculé">
              {row.lastPricedAt === null ? (
                <span className="faint">jamais</span>
              ) : (
                <span className="mono">{row.lastPricedAt}</span>
              )}
            </Champ>

            <Champ nom="eBay">
              {row.listedEbay ? (
                <span style={{ color: 'var(--green)' }}>listée</span>
              ) : (
                <span className="faint">pas encore listée</span>
              )}
            </Champ>

            <Champ nom="TCGplayer">
              {row.tcgDirty ? (
                <span style={{ color: 'var(--amber)' }}>à pousser au prochain export</span>
              ) : (
                <span className="faint">à jour</span>
              )}
            </Champ>
          </dl>

          <p className="faint" style={{ fontSize: 11, margin: 0, lineHeight: 1.5 }}>
            Lecture seule. Changer la condition ou le variant change le SKU, donc
            déplace une quantité d’une ligne d’inventaire à une autre — c’est un
            mouvement de stock, pas une correction de champ.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Champ({ nom, children }: { nom: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="label">{nom}</dt>
      <dd>{children}</dd>
    </>
  );
}
