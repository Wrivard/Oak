import { Suspense } from 'react';
import InventoryClient from './inventory-client.js';
import { loadInventory, type SortKey, type StockFilter } from './queries.js';

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

  const data = await loadInventory({
    page: Number(one('page') ?? 1) || 1,
    ...(one('q') ? { search: one('q') as string } : {}),
    sort: (one('sort') ?? 'value') as SortKey,
    filter: (one('filter') ?? 'in_stock') as StockFilter,
  });

  return (
    <Suspense>
      <InventoryClient data={data} />
    </Suspense>
  );
}
