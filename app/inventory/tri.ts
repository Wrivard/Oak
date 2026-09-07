/**
 * Le vocabulaire du tri, SANS la base.
 *
 * Ces valeurs sont lues par la table côté navigateur et par la requête côté
 * serveur. Les laisser dans `queries.ts` faisait entrer `lib/db.ts`, donc `pg`,
 * donc `fs`, dans le bundle client : `Module not found: Can't resolve 'fs'` et
 * l'écran entier en 500. Un `import type` s'efface à la compilation, une
 * constante non.
 */
export type SortKey = 'value' | 'qty' | 'name' | 'recent';
export type SortDir = 'asc' | 'desc';
export type StockFilter = 'all' | 'in_stock' | 'out' | 'unpriced' | 'unlisted';

/**
 * Le sens qu'on veut d'abord : le plus cher, le plus nombreux, le plus récent —
 * mais les noms dans l'ordre alphabétique.
 */
export const SENS_PAR_DEFAUT: Record<SortKey, SortDir> = {
  value: 'desc',
  qty: 'desc',
  name: 'asc',
  recent: 'desc',
};

export const TRIS: readonly SortKey[] = ['value', 'qty', 'name', 'recent'];
export const SENS: readonly SortDir[] = ['asc', 'desc'];
export const FILTRES: readonly StockFilter[] = [
  'all',
  'in_stock',
  'out',
  'unpriced',
  'unlisted',
];

/**
 * Tableau ou grille.
 *
 * Le tableau compare — prix, quantité, ancienneté, alignés en colonnes. La
 * grille RECONNAÎT : un vendeur de cartes retrouve une carte par son
 * illustration bien avant de lire son nom, et c'est le geste qu'on fait pour
 * répondre à « est-ce que j'ai celle-là ». Deux questions différentes, deux
 * mises en page, et l'URL porte le choix pour qu'il survive à la navigation.
 */
export type Vue = 'tableau' | 'grille';
export const VUES: readonly Vue[] = ['tableau', 'grille'];
