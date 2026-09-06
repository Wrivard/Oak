'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCents } from '../../lib/pricing/net.js';
import type { InventoryPage } from './queries.js';
import { SENS_PAR_DEFAUT, type SortDir, type SortKey, type StockFilter } from './tri.js';

/**
 * Table d'inventaire. Voir docs/06-ui.md.
 *
 * Pagination SERVEUR : à 12-15k SKUs, rendre tout coûterait des secondes et des
 * dizaines de mégaoctets de DOM. On en montre 50, et l'URL porte l'état — un lien
 * vers une page filtrée reste valide, et le retour arrière du navigateur marche.
 */
const FILTRES: { key: StockFilter; label: string }[] = [
  { key: 'in_stock', label: 'En stock' },
  { key: 'unpriced', label: 'Sans prix' },
  { key: 'unlisted', label: 'Non listées' },
  { key: 'out', label: 'Épuisées' },
  { key: 'all', label: 'Tout' },
];

const COLONNES: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'name', label: 'Carte' },
  { key: 'qty', label: 'Qté', align: 'right' },
  { key: 'value', label: 'Valeur', align: 'right' },
];

export default function InventoryClient({ data }: { data: InventoryPage }) {
  const router = useRouter();
  const params = useSearchParams();

  const sort = (params.get('sort') ?? 'value') as SortKey;
  const dir = (params.get('dir') ?? SENS_PAR_DEFAUT[sort]) as SortDir;
  const filter = (params.get('filter') ?? 'in_stock') as StockFilter;
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const navigate = useCallback(
    (next: Record<string, string | undefined>) => {
      const url = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined || v === '') url.delete(k);
        else url.set(k, v);
      }
      setPending(true);
      router.push(`/inventory?${url.toString()}`);
    },
    [params, router],
  );

  useEffect(() => setPending(false), [data]);

  // Recherche débouncée : chaque frappe déclenche une requête serveur, et sans
  // délai on en lance une par lettre pour n'en garder qu'une.
  function onSearch(value: string) {
    setSearch(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => navigate({ q: value, page: '1' }), 250);
  }

  // `/` met le focus dans la recherche : le réflexe partout ailleurs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'INPUT') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { totals } = data;

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Inventaire</h1>
        <span className="page-sub">
          {totals.skus.toLocaleString('fr')} SKUs · {totals.cartes.toLocaleString('fr')}{' '}
          cartes · {formatCents(totals.valeurCents)}
        </span>
        <div className="page-actions">
          <input
            ref={searchRef}
            className="input"
            style={{ width: 240 }}
            placeholder="Rechercher…  /"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
      </header>

      <div className="page-body">
        <div className="large">
        <div style={{ display: 'flex', gap: 'var(--s2)', marginBottom: 'var(--s3)' }}>
          {FILTRES.map((f) => (
            <button
              key={f.key}
              className={`btn${filter === f.key ? ' btn--primary' : ''}`}
              onClick={() => navigate({ filter: f.key, page: '1' })}
            >
              {f.label}
            </button>
          ))}
          {totals.sansPrix > 0 && filter !== 'unpriced' && (
            <span
              className="note note--warn"
              style={{ marginLeft: 'auto', padding: '4px var(--s3)', fontSize: 12 }}
            >
              {totals.sansPrix} SKU{totals.sansPrix > 1 ? 's' : ''} en stock sans prix
            </span>
          )}
        </div>

        {data.rows.length === 0 ? (
          <div className="empty" style={{ height: 240 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Rien ici</div>
            <div className="dim">
              {search
                ? 'Aucun SKU ne correspond à cette recherche.'
                : 'L’inventaire se remplit à mesure que les cartes sont résolues.'}
            </div>
          </div>
        ) : (
          <div className="cadre">
          <table className="table" style={{ opacity: pending ? 0.55 : 1, transition: 'opacity 120ms' }}>
            <thead>
              <tr>
                {COLONNES.map((c) => (
                  /* Recliquer la colonne active INVERSE le sens. Sans ça,
                     « la moins chère » était inaccessible : on ne pouvait
                     trier que du plus cher au moins cher, alors que trouver le
                     bulk sans valeur est exactement ce qu'on cherche avant un
                     export. Une autre colonne part dans SON sens naturel — le
                     plus cher, le plus nombreux, mais les noms de A à Z. */
                  <th
                    key={c.key}
                    className="th-tri"
                    style={{ textAlign: c.align ?? 'left' }}
                    /* Une colonne triable se pilote AUSSI au clavier : ailleurs
                       dans cette application tout se fait sans souris, et un
                       en-tête qui n'obéit qu'au clic est une exception qu'on
                       découvre en la cherchant. `aria-sort` dit le sens en
                       cours plutôt que de le laisser à la flèche seule. */
                    tabIndex={0}
                    role="columnheader"
                    aria-sort={
                      sort === c.key
                        ? dir === 'desc'
                          ? 'descending'
                          : 'ascending'
                        : 'none'
                    }
                    title={
                      sort === c.key
                        ? 'Cliquer pour inverser le sens'
                        : `Trier par ${c.label.toLowerCase()}`
                    }
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.currentTarget.click();
                    }}
                    onClick={() =>
                      navigate({
                        sort: c.key,
                        dir:
                          sort === c.key
                            ? dir === 'desc'
                              ? 'asc'
                              : 'desc'
                            : SENS_PAR_DEFAUT[c.key],
                        page: '1',
                      })
                    }
                  >
                    {c.label}
                    {sort === c.key && (dir === 'desc' ? ' ↓' : ' ↑')}
                  </th>
                ))}
                <th>Prix</th>
                <th>Canaux</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.sku}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
                      {r.image && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={r.image}
                          alt=""
                          loading="lazy"
                          style={{
                            width: 26,
                            height: 36,
                            objectFit: 'cover',
                            borderRadius: 3,
                            background: 'var(--surface-2)',
                          }}
                        />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 500,
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {r.name}
                        </div>
                        <div className="faint" style={{ fontSize: 11 }}>
                          {r.set_name} · {r.variant} · {r.condition}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num">
                    {r.qty_on_hand}
                    {r.qty_reserved_tcg > 0 && (
                      <span className="faint" style={{ fontWeight: 400 }}>
                        {' '}
                        ({r.qty_reserved_tcg} rés.)
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    {r.valueCents === null ? (
                      <span className="faint">—</span>
                    ) : (
                      formatCents(r.valueCents)
                    )}
                  </td>
                  <td className="num">
                    {r.priceCents === null ? (
                      // « non prixé » sans raison envoie relire les journaux du
                      // worker. Le pipeline écrit déjà le pourquoi dans
                      // price_breakdown — un printing absent de la source, une
                      // devise non convertie, aucune donnée du tout.
                      <span
                        className="faint"
                        style={{ fontWeight: 400, cursor: r.priceReason ? 'help' : undefined }}
                        title={r.priceReason ?? undefined}
                      >
                        non prixé{r.priceReason ? ' ⓘ' : ''}
                        {/* Dans la vue « Sans prix », la raison est le sujet de
                            la page : survoler cinquante lignes une par une pour
                            la lire n'est pas une lecture. */}
                        {filter === 'unpriced' && r.priceReason && (
                          <span
                            style={{
                              display: 'block',
                              fontWeight: 400,
                              fontSize: 10,
                              lineHeight: 1.3,
                              maxWidth: 220,
                              whiteSpace: 'normal',
                              textAlign: 'right',
                            }}
                          >
                            {r.priceReason}
                          </span>
                        )}
                      </span>
                    ) : (
                      formatCents(r.priceCents)
                    )}
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                      <span
                        className="label"
                        style={{ color: r.listedEbay ? 'var(--green)' : 'var(--text-faint)' }}
                        title={r.listedEbay ? 'listée sur eBay' : 'pas encore sur eBay'}
                      >
                        eBay
                      </span>
                      <span
                        className="label"
                        style={{ color: r.tcgDirty ? 'var(--amber)' : 'var(--text-faint)' }}
                        title={r.tcgDirty ? 'à pousser vers TCGplayer' : 'à jour chez TCGplayer'}
                      >
                        TCG
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {data.pages > 1 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--s3)',
              marginTop: 'var(--s4)',
            }}
          >
            <button
              className="btn"
              disabled={data.page <= 1}
              onClick={() => navigate({ page: String(data.page - 1) })}
            >
              Précédent
            </button>
            <span className="mono dim" style={{ fontSize: 12 }}>
              page {data.page} / {data.pages} · {data.total.toLocaleString('fr')} lignes
            </span>
            <button
              className="btn"
              disabled={data.page >= data.pages}
              onClick={() => navigate({ page: String(data.page + 1) })}
            >
              Suivant
            </button>
          </div>
        )}
        </div>
      </div>
    </>
  );
}
