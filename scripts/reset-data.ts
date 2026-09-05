/**
 * Remet les données d'exploitation à zéro, pour recommencer un essai propre.
 *
 *   pnpm reset:data --confirm            efface scans, inventaire, lots, jobs
 *   pnpm reset:data --confirm --keep-fp  garde known_fingerprints
 *
 * NE TOUCHE JAMAIS `cards` ni `card_embeddings` : 20 000 cartes et autant
 * d'embeddings représentent une heure de calcul, et rien dans un essai ne
 * justifie de les perdre. Pour les reconstruire : `pnpm seed:catalog` puis
 * `pnpm seed:embeddings`.
 *
 * `--confirm` est obligatoire. Un script qui efface l'inventaire ne doit pas
 * pouvoir partir sur une faute de frappe dans un historique de terminal.
 */
import { rm } from 'node:fs/promises';
import { closePool, query } from '../lib/db.js';
import { log } from '../lib/log.js';

/** Effacées dans cet ordre : les dépendances d'abord. */
const TABLES = [
  'jobs',
  'channel_events',
  'price_history',
  'price_current',
  'scans',
  'inventory',
  'sessions',
] as const;

/** Répertoires d'essai. Les originaux ne sont pas archivés (docs/02 §6). */
const DIRS = ['./uploads', './inbox', './processed', './rejected', './.thumb-cache', './exports'];

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (!args.has('--confirm')) {
    log.error(
      'reset annulé : --confirm est obligatoire. ' +
        'Ce script efface scans, inventaire, lots et jobs.',
    );
    process.exitCode = 1;
    return;
  }

  const keepFingerprints = args.has('--keep-fp');

  // Ce qu'on est sur le point de perdre, AVANT de le perdre.
  const { rows } = await query<{
    scans: string;
    inventory: string;
    fingerprints: string;
    cartes: string;
  }>(
    `select (select count(*) from scans)::text as scans,
            (select count(*) from inventory)::text as inventory,
            (select count(*) from known_fingerprints)::text as fingerprints,
            (select coalesce(sum(qty_on_hand),0) from inventory)::text as cartes`,
  );
  const avant = rows[0];

  log.warn('effacement des données d’exploitation', {
    scans: Number(avant?.scans ?? 0),
    skus: Number(avant?.inventory ?? 0),
    cartes_en_stock: Number(avant?.cartes ?? 0),
    empreintes: Number(avant?.fingerprints ?? 0),
    empreintes_conservees: keepFingerprints,
  });

  if (!keepFingerprints) {
    // known_fingerprints d'abord : elle référence cards, pas l'inverse.
    await query('delete from known_fingerprints');
  }
  for (const table of TABLES) {
    await query(`delete from ${table}`);
  }

  for (const dir of DIRS) {
    await rm(dir, { recursive: true, force: true });
  }

  const { rows: apres } = await query<{ cards: string; embeddings: string }>(
    `select (select count(*) from cards)::text as cards,
            (select count(*) from card_embeddings)::text as embeddings`,
  );

  log.info('reset terminé', {
    // Ce qui est PRÉSERVÉ : c'est ce qui coûte cher à reconstruire.
    catalogue_preserve: Number(apres[0]?.cards ?? 0),
    embeddings_preserves: Number(apres[0]?.embeddings ?? 0),
    empreintes_conservees: keepFingerprints,
  });
}

main()
  .catch((err: unknown) => {
    log.error('reset échoué', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool());
