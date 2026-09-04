/**
 * Seed du catalogue Pokémon depuis github.com/PokemonTCG/pokemon-tcg-data.
 *
 *   pnpm seed:catalog
 *
 * Idempotent : relançable sans doublons (upsert sur cards.id).
 * Reprenable  : un set dont le compte en base correspond déjà au fichier est sauté,
 *               donc une coupure en cours de route ne coûte que le set interrompu.
 *
 * Échoue avec exit 1 si le total est sous 15 000 cartes — un catalogue partiel
 * casse silencieusement le niveau 2 du matching.
 */
import { closePool, query, withTransaction } from '../lib/db.js';
import { log } from '../lib/log.js';

const RAW = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
const MIN_CARDS = 15_000;
const CHUNK = 500;

/**
 * Les champs qu'on consomme. Le dump en contient bien plus (attaques, HP,
 * faiblesses) — rien de tout ça n'aide à identifier une carte scannée.
 *
 * Note : le dump ne porte PAS de champs tcgplayer/cardmarket. Les colonnes
 * correspondantes restent nulles jusqu'à l'étape 10.
 */
interface RawSet {
  id: string;
  name: string;
  series?: string;
  printedTotal?: number;
  total?: number;
  releaseDate?: string; // "1999/01/09"
}

interface RawCard {
  id: string;
  name: string;
  number: string;
  rarity?: string;
  supertype?: string;
  subtypes?: string[];
  artist?: string;
  images?: { small?: string; large?: string };
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${RAW}/${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** "1999/01/09" → "1999-01-09". Null si absent ou malformé. */
function toDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const COLUMNS = [
  'id', 'name', 'set_id', 'set_name', 'set_series', 'set_release',
  'number', 'printed_total', 'total', 'rarity', 'supertype', 'subtypes',
  'artist', 'language', 'image_small', 'image_large',
] as const;

function rowFor(card: RawCard, set: RawSet): unknown[] {
  return [
    card.id,
    card.name,
    set.id,
    set.name,
    set.series ?? null,
    toDate(set.releaseDate),
    card.number,
    // printedTotal et total viennent du SET, pas de la carte. C'est le dénominateur
    // imprimé sur la carte — la clé du filtre déterministe du niveau 2.
    set.printedTotal ?? null,
    set.total ?? null,
    card.rarity ?? null,
    card.supertype ?? null,
    card.subtypes ?? null,
    card.artist ?? null,
    'en',
    card.images?.small ?? null,
    card.images?.large ?? null,
  ];
}

async function upsertChunk(rows: unknown[][]): Promise<void> {
  const width = COLUMNS.length;
  const values = rows
    .map((_, r) => `(${COLUMNS.map((_c, i) => `$${r * width + i + 1}`).join(',')})`)
    .join(',');

  const updates = COLUMNS.filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  await query(
    `insert into cards (${COLUMNS.join(',')}) values ${values}
       on conflict (id) do update set ${updates}, updated_at = now()`,
    rows.flat(),
  );
}

async function main(): Promise<void> {
  const started = Date.now();
  log.info('seed catalogue — début');

  const sets = await fetchJson<RawSet[]>('sets/en.json');
  log.info('sets récupérés', { n_sets: sets.length });

  // Comptes déjà en base, pour la reprise.
  const existing = new Map<string, number>();
  const counts = await query<{ set_id: string; n: string }>(
    'select set_id, count(*)::text as n from cards group by set_id',
  );
  for (const row of counts.rows) existing.set(row.set_id, Number(row.n));

  let inserted = 0;
  let skipped = 0;

  for (const set of sets) {
    let cards: RawCard[];
    try {
      cards = await fetchJson<RawCard[]>(`cards/en/${set.id}.json`);
    } catch (err) {
      // Un set listé sans fichier de cartes existe (set annoncé, pas encore dumpé).
      // On le note et on continue : échouer ici perdrait les 173 autres.
      log.warn('set sans fichier de cartes, ignoré', { set_id: set.id, err });
      continue;
    }

    if (existing.get(set.id) === cards.length) {
      skipped += cards.length;
      log.debug('set déjà seedé, sauté', { set_id: set.id, n: cards.length });
      continue;
    }

    const rows = cards.map((c) => rowFor(c, set));
    await withTransaction(async () => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        await upsertChunk(rows.slice(i, i + CHUNK));
      }
    });

    inserted += rows.length;
    log.info('set seedé', {
      set_id: set.id,
      set_name: set.name,
      n: rows.length,
      printed_total: set.printedTotal ?? null,
      total: set.total ?? null,
    });
  }

  const final = await query<{ n: string }>('select count(*)::text as n from cards');
  const totalCards = Number(final.rows[0]?.n ?? 0);

  log.info('seed catalogue — fin', {
    total_cards: totalCards,
    inserted,
    skipped,
    duration_ms: Date.now() - started,
  });

  if (totalCards < MIN_CARDS) {
    log.error('catalogue incomplet', { total_cards: totalCards, minimum: MIN_CARDS });
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    log.error('seed catalogue échoué', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool());
