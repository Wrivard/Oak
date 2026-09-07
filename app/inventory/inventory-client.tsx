'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCents } from '../../lib/pricing/net.js';
import type { InventoryPage, InventoryRow } from './queries.js';
import Fiche from './fiche.js';
import Astuce from '../shell/astuce.js';
import { useAvis } from '../shell/toast.js';
import { SENS_PAR_DEFAUT, type SortDir, type SortKey, type StockFilter, type Vue } from './tri.js';

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

export default function InventoryClient({
  data,
  vue,
}: {
  data: InventoryPage;
  vue: Vue;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const { avis } = useAvis();

  const sort = (params.get('sort') ?? 'value') as SortKey;
  const dir = (params.get('dir') ?? SENS_PAR_DEFAUT[sort]) as SortDir;
  const filter = (params.get('filter') ?? 'in_stock') as StockFilter;
  const [search, setSearch] = useState(params.get('q') ?? '');
  /** Le SKU ouvert en fiche, ou `null`. */
  const [fiche, setFiche] = useState<InventoryRow | null>(null);
  /**
   * Les SKUs cochés.
   *
   * La sélection ne SURVIT PAS au changement de page, et c'est voulu : elle vit
   * dans l'écran, pas dans l'URL. Une sélection invisible qui traîne sur trois
   * pages est le meilleur moyen de copier autre chose que ce qu'on regarde.
   */
  const [choisis, setChoisis] = useState<Set<string>>(new Set());
  useEffect(() => setChoisis(new Set()), [data]);
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
      // Même raison que dans la review : `Ctrl+/` appartient au navigateur.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const basculer = (sku: string): void =>
    setChoisis((s) => {
      const n = new Set(s);
      if (n.has(sku)) n.delete(sku);
      else n.add(sku);
      return n;
    });

  const lignesChoisies = data.rows.filter((r) => choisis.has(r.sku));
  const valeurChoisie = lignesChoisies.reduce((s, r) => s + (r.priceCents ?? 0), 0);

  /**
   * Copier la sélection, en SKUs seuls ou en tableau.
   *
   * Ce sont les deux gestes réels : coller une liste de SKUs dans un champ de
   * recherche TCGplayer, ou coller un tableau dans un tableur pour compter. Le
   * séparateur est la tabulation — c'est ce qu'un tableur attend, et un
   * point-virgule dépend de la langue du logiciel.
   */
  async function copier(format: 'sku' | 'tableur'): Promise<void> {
    const LIGNE = '\n';
    const COL = '\t';
    const texte =
      format === 'sku'
        ? lignesChoisies.map((r) => r.sku).join(LIGNE)
        : [
            ['sku', 'carte', 'set', 'variant', 'condition', 'qte', 'prix'].join(COL),
            ...lignesChoisies.map((r) =>
              [
                r.sku,
                r.name,
                r.set_name,
                r.variant,
                r.condition,
                String(r.qty_on_hand),
                r.priceCents === null ? '' : (r.priceCents / 100).toFixed(2),
              ].join(COL),
            ),
          ].join(LIGNE);

    try {
      await navigator.clipboard.writeText(texte);
      avis('ok', `${lignesChoisies.length} ligne${lignesChoisies.length > 1 ? 's' : ''} copiée${lignesChoisies.length > 1 ? 's' : ''}`,
        format === 'sku' ? 'Les SKUs, un par ligne.' : 'Colonnes séparées par des tabulations.');
    } catch {
      avis('warn', 'Copie impossible', 'Le navigateur a refusé l’accès au presse-papiers.');
    }
  }

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
          {/* Le tableau COMPARE, la grille RECONNAÎT. Un vendeur de cartes
              retrouve une carte par son illustration bien avant de lire son
              nom ; c'est le geste qu'on fait pour répondre à « est-ce que j'ai
              celle-là ». Le choix vit dans l'URL, il survit à la navigation. */}
          <div className="segmente">
            <button
              className="seg"
              data-actif={vue === 'tableau' ? 'true' : undefined}
              onClick={() => navigate({ vue: undefined })}
              title="Tableau"
              aria-label="Vue tableau"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="seg"
              data-actif={vue === 'grille' ? 'true' : undefined}
              onClick={() => navigate({ vue: 'grille' })}
              title="Grille"
              aria-label="Vue grille"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="page-body">
        <div className="large">
        <div style={{ display: 'flex', gap: 'var(--s2)', marginBottom: 'var(--s3)' }}>
          {/* Un seul réglage à cinq positions. Voir `.segmente` dans la feuille
              de style : le segment actif est soulevé et non coloré, le vert
              restant aux actions qui écrivent quelque chose. */}
          <div className="segmente">
            {FILTRES.map((f) => (
              <button
                key={f.key}
                className="seg"
                data-actif={filter === f.key ? 'true' : undefined}
                onClick={() => navigate({ filter: f.key, page: '1' })}
              >
                {f.label}
              </button>
            ))}
          </div>
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
        ) : vue === 'grille' ? (
          /*
            LA GRILLE. Les mêmes lignes, la même pagination, le même tri — seule
            la mise en page change. Une vue qui filtrerait autrement que le
            tableau serait une seconde application à tenir à jour.

            La tuile porte le strict nécessaire pour reconnaître et décider :
            l'illustration, le nom, le prix, la quantité, l'état. Le reste est
            dans la fiche, à un clic.
          */
          <div
            className="inv-grille"
            style={{ opacity: pending ? 0.55 : 1, transition: 'opacity 120ms' }}
          >
            {data.rows.map((r) => (
              <button
                key={r.sku}
                className="tuile"
                data-ouverte={fiche?.sku === r.sku ? 'true' : undefined}
                onClick={() => setFiche(r)}
                title={`${r.name} — ${r.sku}`}
              >
                <span className="tuile-image">
                  {r.image !== null ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={r.image} alt="" loading="lazy" />
                  ) : (
                    <span className="tuile-vide">pas d’image</span>
                  )}
                  {/* La quantité EN SURIMPRESSION, comme sur une pile : au-delà
                      de un, c'est l'information qui décide d'un export. */}
                  {r.qty_on_hand > 1 && <span className="tuile-qte">×{r.qty_on_hand}</span>}
                  {r.qty_on_hand === 0 && <span className="tuile-epuisee">épuisée</span>}
                </span>
                <span className="tuile-nom tronque">{r.name}</span>
                <span className="tuile-sous tronque">
                  {r.set_name} · {r.condition}
                </span>
                <span className="tuile-prix">
                  {r.priceCents === null ? (
                    <span className="etat etat--attente">sans prix</span>
                  ) : (
                    <>
                      <span className="num">{formatCents(r.priceCents)}</span>
                      {r.listedEbay && <span className="etat etat--ok">listée</span>}
                    </>
                  )}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="cadre">
          <table className="table" style={{ opacity: pending ? 0.55 : 1, transition: 'opacity 120ms' }}>
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input
                    type="checkbox"
                    className="check"
                    aria-label="Tout sélectionner sur cette page"
                    checked={choisis.size > 0 && choisis.size === data.rows.length}
                    // `indeterminate` n'existe pas en HTML : c'est une propriété
                    // du noeud. Sans elle, une sélection partielle affiche une
                    // case vide et on croit n'avoir rien coché.
                    ref={(el) => {
                      if (el) el.indeterminate = choisis.size > 0 && choisis.size < data.rows.length;
                    }}
                    onChange={() =>
                      setChoisis((s) =>
                        s.size === data.rows.length ? new Set() : new Set(data.rows.map((r) => r.sku)),
                      )
                    }
                  />
                </th>
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
                <th>État</th>
                <th>Ajouté</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                /* La LIGNE ENTIÈRE ouvre la fiche. Un bouton « détail » en
                   bout de ligne demanderait de viser une cible de vingt pixels
                   au bout d'un tableau de mille pixels, cinquante fois par
                   page. `tabIndex` et Entrée pour que ça marche aussi au
                   clavier, comme le reste de l'application. */
                <tr
                  key={r.sku}
                  className="ligne-cliquable"
                  data-ouverte={fiche?.sku === r.sku ? 'true' : undefined}
                  tabIndex={0}
                  onClick={() => setFiche(r)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    setFiche(r);
                  }}
                >
                  {/* La case ARRÊTE le clic : la ligne entière ouvre la fiche,
                      et cocher n'est pas ouvrir. */}
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="check"
                      aria-label={`Sélectionner ${r.name}`}
                      checked={choisis.has(r.sku)}
                      onChange={() => basculer(r.sku)}
                    />
                  </td>
                  <td className="cell-texte">
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
                  {/* UN ÉTAT, pas deux étiquettes de trois lettres. « EBAY
                      TCG » en gris demandait de connaître le code couleur pour
                      savoir si la carte était en vente. Un mot le dit. */}
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                      {r.qty_on_hand === 0 ? (
                        <span className="etat etat--muet">épuisée</span>
                      ) : r.priceCents === null ? (
                        <Astuce cote="fin" texte={r.priceReason ?? 'Aucun prix calculé pour ce SKU.'}>
                          <span className="etat etat--attente">sans prix</span>
                        </Astuce>
                      ) : r.listedEbay ? (
                        <span className="etat etat--ok">listée</span>
                      ) : (
                        <Astuce cote="fin" texte="Prixée mais pas encore mise en vente sur eBay.">
                          <span className="etat etat--muet">à lister</span>
                        </Astuce>
                      )}
                      {r.tcgDirty && (
                        <Astuce
                          cote="fin"
                          texte="Modifiée depuis le dernier export : elle partira dans le prochain fichier TCGplayer."
                        >
                          <span className="etat etat--attente">TCG</span>
                        </Astuce>
                      )}
                    </span>
                  </td>
                  <td className="mono faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {r.ajouteIlYA}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {/*
          LA BARRE DE SÉLECTION. En bas et flottante : elle apparaît sans
          pousser le tableau, et elle reste sous la main quel que soit
          l'endroit où on a fait défiler.

          Ce qu'elle propose est volontairement SANS ÉCRITURE. Une action de
          masse sur l'inventaire — changer une condition, un variant — change
          le SKU, donc déplace des quantités d'une ligne à l'autre : c'est un
          mouvement de stock, et ça ne se met pas derrière un bouton qui agit
          sur cinquante lignes cochées à la volée.
        */}
        {choisis.size > 0 && (
          <div className="selection">
            <span className="selection-compte">
              <span className="num">{choisis.size}</span> sélectionné
              {choisis.size > 1 ? 's' : ''}
              {valeurChoisie > 0 && (
                <span className="faint"> · {formatCents(valeurChoisie)}</span>
              )}
            </span>
            <button className="btn btn--sm" onClick={() => void copier('sku')}>
              Copier les SKUs
            </button>
            <button className="btn btn--sm" onClick={() => void copier('tableur')}>
              Copier en tableur
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setChoisis(new Set())}
              title="Tout décocher"
            >
              Effacer
            </button>
          </div>
        )}

        <Fiche row={fiche} onFermer={() => setFiche(null)} />

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
