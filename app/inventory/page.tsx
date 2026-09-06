import { Suspense } from 'react';
import InventoryClient from './inventory-client.js';
import { loadInventory } from './queries.js';
import {
  FILTRES,
  SENS,
  SENS_PAR_DEFAUT,
  TRIS,
  type SortDir,
  type SortKey,
  type StockFilter,
} from './tri.js';

/**
 * L'URL est une entrée, pas une promesse.
 *
 * Les paramètres étaient CASTÉS : `?sort=drop` donnait `ORDER['drop']`, c'est-à-
 * dire `undefined`, interpolé dans un `order by` — une page en 500 sur une
 * adresse mal recopiée. On valide contre la liste, et on retombe sur le défaut
 * plutôt que d'échouer : une clé de tri inconnue ne mérite pas une page
 * d'erreur.
 */
function dans<T extends string>(liste: readonly T[], v: string | undefined, defaut: T): T {
  return liste.includes(v as T) ? (v as T) : defaut;
}

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Inventaire' };

/**
 * L'état de la table vit dans l'URL : un lien vers une page filtrée reste
 * valide, et le retour arrière du navigateur fait ce qu'on attend.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const sort = dans(TRIS, one('sort'), 'value');

  const data = await loadInventory({
    page: Number(one('page') ?? 1) || 1,
    ...(one('q') ? { search: one('q') as string } : {}),
    sort,
    dir: dans(SENS, one('dir'), SENS_PAR_DEFAUT[sort]),
    filter: dans(FILTRES, one('filter'), 'in_stock'),
  });

  return (
    <Suspense>
      <InventoryClient data={data} />
    </Suspense>
  );
}
