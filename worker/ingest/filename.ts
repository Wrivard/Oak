/**
 * Nommage produit par PaperStream : `{session}_{seq:06d}_{side}.jpg`.
 * Voir docs/02-ingest-and-matching.md §1.
 *
 * Le nom de session peut contenir des tirets et des espaces mais pas de `_` :
 * c'est le séparateur. Le découpage se fait par la droite, comme pour les SKU.
 */
export type Side = 'front' | 'back';

export interface ParsedName {
  session: string;
  seq: number;
  side: Side;
}

const EXT = /\.(jpe?g|png)$/i;

export function parseName(basename: string): ParsedName | null {
  const withoutExt = basename.replace(EXT, '');
  if (withoutExt === basename) return null; // extension non reconnue

  const parts = withoutExt.split('_');
  if (parts.length < 3) return null;

  const side = parts.pop()?.toLowerCase();
  if (side !== 'front' && side !== 'back') return null;

  const seqRaw = parts.pop();
  if (seqRaw === undefined || !/^\d+$/.test(seqRaw)) return null;
  const seq = Number(seqRaw);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;

  const session = parts.join('_');
  if (session.length === 0) return null;

  return { session, seq, side };
}
