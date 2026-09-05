/**
 * Remplit la base au VOLUME CIBLE pour mesurer les écrans.
 *
 *   pnpm seed:volume 15000        crée ~15 000 SKUs et autant de scans
 *   pnpm seed:volume --purge      efface ce que ce script a créé
 *
 * Pourquoi : « la page compile » et « la page charge » sont déjà deux choses
 * différentes ; « la page charge sur onze lignes » et « la page charge sur
 * quinze mille » en sont une troisième. Un `order by` sans index tient dix
 * lignes sans broncher et rend une page inutilisable à l'échelle réelle, et
 * l'échelle réelle ici est de 12 à 15 000 SKUs pour 25 à 50 000 cartes par mois.
 *
 * Tout ce qui est créé porte le nom de lot `volume-test` et des SKUs en
 * `-volumetest`, pour que la purge soit exacte et ne touche rien d'autre.
 */
import { closePool, query } from '../lib/db.js';
import { log } from '../lib/log.js';

const SESSION = 'volume-test';
const MARQUEUR = 'volumetest';

async function purge(): Promise<void> {
  // Les dépendances d'abord. `channel_events` et `price_history` référencent
  // les SKUs par texte, pas par clé étrangère : ils se nettoient au motif.
  const etapes: [string, string][] = [
    [
      'jobs',
      `delete from jobs where payload->>'scan_id' in (
         select s.id::text from scans s join sessions ss on ss.id = s.session_id
          where ss.name = '${SESSION}')`,
    ],
    [
      'scans',
      `delete from scans where session_id in (select id from sessions where name = '${SESSION}')`,
    ],
    ['price_history', `delete from price_history where sku like '%-${MARQUEUR}'`],
    ['channel_events', `delete from channel_events where sku like '%-${MARQUEUR}'`],
    ['inventory', `delete from inventory where sku like '%-${MARQUEUR}'`],
    ['sessions', `delete from sessions where name = '${SESSION}'`],
  ];
  for (const [nom, sql] of etapes) {
    const { rowCount } = await query(sql);
    console.log(`  ${nom.padEnd(15)} ${rowCount ?? 0} lignes effacées`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--purge')) {
    console.log('\n  purge du jeu de volume\n');
    await purge();
    await closePool();
    return;
  }

  const cible = Number(args[0] ?? 15_000);

  // On repart propre : deux passages accumuleraient et fausseraient la mesure.
  await purge();

  const { rows: session } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition, expected_count)
     values ($1, 'normal', 'NM', $2) returning id`,
    [SESSION, cible],
  );
  const sessionId = session[0]!.id;

  const t0 = Date.now();

  // Un SKU par (carte, condition) : c'est la vraie forme de l'inventaire, où
  // une même carte existe en plusieurs états. `insert ... select` fait tout
  // côté serveur — quinze mille allers-retours prendraient des minutes.
  const { rowCount: inv } = await query(
    `insert into inventory
       (sku, card_id, variant, condition, language, qty_on_hand,
        value_estimate, current_price, last_priced_at, ebay_listing_id)
     select c.id || '-normal-' || cond || '-en-${MARQUEUR}',
            c.id, 'normal', cond::card_condition, 'en',
            (abs(hashtext(c.id || cond)) % 6),
            round((abs(hashtext(c.id)) % 9000)::numeric / 100 + 0.25, 2),
            case when abs(hashtext(c.id)) % 7 = 0 then null
                 else round((abs(hashtext(c.id)) % 9000)::numeric / 100 + 1.75, 2) end,
            now() - (abs(hashtext(c.id)) % 30 || ' days')::interval,
            case when abs(hashtext(c.id)) % 3 = 0 then 'ebay-' || c.id else null end
       from (select id from cards order by md5(id) limit $1) c
       cross join (values ('NM'),('LP'),('MP')) as v(cond)
     on conflict (sku) do nothing`,
    [Math.ceil(cible / 3)],
  );

  // Des scans dans tous les états, pour que la review, l'audit et le
  // diagnostic aient de quoi rendre.
  const { rowCount: scans } = await query(
    `insert into scans
       (session_id, seq, front_path, status, match_source, confidence,
        resolved_sku, resolved_at, ocr_read, ocr_confidence, ocr_band, candidates)
     select $1,
            row_number() over (order by i.sku),
            'uploads/${SESSION}/' || lpad((row_number() over (order by i.sku))::text, 6, '0') || '.jpg',
            (array['resolved','resolved','resolved','needs_review','needs_review'])[1 + abs(hashtext(i.sku)) % 5]::scan_status,
            case when abs(hashtext(i.sku)) % 5 < 3
                 then (array['own_history','catalog','manual'])[1 + abs(hashtext(i.sku)) % 3]::match_source
                 else null end,
            case when abs(hashtext(i.sku)) % 5 < 3
                 then round((0.5 + (abs(hashtext(i.sku)) % 50)::numeric / 100), 2)
                 else null end,
            case when abs(hashtext(i.sku)) % 5 < 3 then i.sku else null end,
            case when abs(hashtext(i.sku)) % 5 < 3 then now() - (abs(hashtext(i.sku)) % 72 || ' hours')::interval else null end,
            case when abs(hashtext(i.sku)) % 3 = 0 then null else (abs(hashtext(i.sku)) % 200)::text end,
            case when abs(hashtext(i.sku)) % 3 = 0 then null else 0.7 end,
            case when abs(hashtext(i.sku)) % 3 = 0 then null else 1 + abs(hashtext(i.sku)) % 3 end,
            '[]'::jsonb
       from inventory i
      where i.sku like '%-${MARQUEUR}'`,
    [sessionId],
  );

  await query(
    `update sessions set scanned_count = $2 where id = $1`,
    [sessionId, scans ?? 0],
  );

  const secondes = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ${inv ?? 0} SKUs · ${scans ?? 0} scans · ${secondes} s\n`);
  log.info('jeu de volume créé', { skus: inv, scans, secondes });

  const { rows: repartition } = await query<{ status: string; n: string }>(
    `select status::text, count(*)::text as n from scans
      where session_id = $1 group by 1 order by 2 desc`,
    [sessionId],
  );
  for (const r of repartition) console.log(`  ${r.status.padEnd(14)} ${r.n}`);
  console.log('\n  purge : pnpm seed:volume --purge\n');

  await closePool();
}

void main();
