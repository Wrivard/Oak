import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { query } from '../../../lib/db.js';
import { log } from '../../../lib/log.js';
import { openSession } from '../../../lib/ingest/register.js';
import type { CardCondition, CardVariant } from '../../../lib/sku.js';
import { estImage } from '../../../lib/upload/drop.js';
import { nomDeLotInvalide } from '../../../lib/upload/nom-de-lot.js';
import { extensionSure } from '../../../lib/images/extensions.js';

/**
 * Dépôt d'un lot de photos.
 *
 * Cette route ne fait qu'ÉCRIRE DES FICHIERS. Elle ne hache rien, n'apparie
 * rien, ne crée aucun scan : sur un lot de plusieurs centaines de photos, une
 * empreinte par image dépasserait largement le temps d'une requête HTTP.
 *
 * L'appariement recto/verso et la création des scans sont faits par le job
 * `pair_upload`, déclenché par `POST /api/upload/finalize` quand tous les
 * paquets sont arrivés. C'est aussi ce qui permet d'apparier correctement : il
 * faut voir TOUT le lot pour distinguer les dos des rectos.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STORE = process.env['UPLOAD_DIR'] ?? './uploads';

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Le nom du fichier PORTE L'ORDRE, et l'ordre porte l'appariement recto/verso.
 * On ne réutilise jamais le nom original : il vient de l'utilisateur et pourrait
 * sortir du répertoire.
 */
function safeName(rank: number, original: string): string {
  return `${String(rank).padStart(6, '0')}${extensionSure(original)}`;
}

/**
 * Rang de départ : la suite de ce qui existe DÉJÀ sur le disque.
 *
 * On ne se fie pas au décalage annoncé par le client pour nommer. Renvoyer deux
 * fois vers le même nom de lot recommence à zéro côté client, et les fichiers du
 * premier envoi étaient ÉCRASÉS EN SILENCE — des cartes physiquement scannées
 * sans aucune trace, ce qui est le pire mode de défaillance du système.
 *
 * Le client envoie ses paquets séquentiellement (une boucle `await`), donc lire
 * le répertoire au début de chaque requête donne bien la continuation.
 */
async function nextRank(dir: string): Promise<number> {
  let existing: string[];
  try {
    existing = await readdir(dir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of existing) {
    const n = Number(/^(\d{6})/.exec(name)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Ce que contient déjà un lot, AVANT d'envoyer.
 *
 * Envoyer deux fois le même dossier n'écrase plus rien — mais ça AJOUTE, et
 * l'inventaire compte alors chaque carte deux fois. La réconciliation finit par
 * l'attraper à la clôture ; la voir avant de lancer 2000 pages coûte moins cher.
 *
 * Ne crée rien : ni session, ni répertoire.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const nom = (new URL(req.url).searchParams.get('session') ?? '').trim();
  if (nomDeLotInvalide(nom) !== null) {
    return NextResponse.json({ pages: 0, scans: 0, status: null });
  }

  let pages = 0;
  try {
    pages = (await readdir(join(STORE, nom))).filter((n) => /^\d{6}\./.test(n)).length;
  } catch {
    // Répertoire absent : le lot n'a jamais reçu de page. Ce n'est pas une erreur.
  }

  const { rows } = await query<{ status: string; scans: string }>(
    `select ss.status::text, count(s.*)::text as scans
       from sessions ss
       left join scans s on s.session_id = ss.id
      where ss.name = $1
      group by ss.id`,
    [nom],
  );

  return NextResponse.json({
    pages,
    scans: Number(rows[0]?.scans ?? 0),
    status: rows[0]?.status ?? null,
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: `formulaire illisible : ${String(err)}` }, { status: 400 });
  }

  const sessionName = String(form.get('session') ?? '').trim();
  const variant = String(form.get('variant') ?? '') as CardVariant;
  const condition = String(form.get('condition') ?? '') as CardCondition;
  const language = String(form.get('language') ?? 'en').trim().toLowerCase();
  const offset = Number(form.get('offset') ?? 0);
  const files = form.getAll('files').filter((f): f is File => f instanceof File);

  const mauvaisNom = nomDeLotInvalide(sessionName);
  if (mauvaisNom !== null) {
    return NextResponse.json({ error: mauvaisNom }, { status: 400 });
  }
  if (files.length === 0) {
    return NextResponse.json({ error: 'aucun fichier' }, { status: 400 });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return NextResponse.json({ error: 'offset invalide' }, { status: 400 });
  }

  const sessionId = await openSession({ name: sessionName, variant, condition, language });
  const dir = join(STORE, sessionName);
  await mkdir(dir, { recursive: true });

  // Le décalage client sert à ordonner DANS la requête ; le rang absolu vient du
  // disque, pour ne jamais écraser un envoi précédent.
  const base = await nextRank(dir);

  let accepted = 0;
  const rejected: { name: string; reason: string }[] = [];

  for (const [i, file] of files.entries()) {
    // Même critère que le client : type MIME OU extension. Chrome laisse `type`
    // vide sur certains `.tif` de scanner ; s'en tenir au MIME refusait des
    // pages réellement scannées. Le vrai filtre est plus loin de toute façon —
    // sharp échoue à décoder ce qui n'est pas une image, et l'échec est visible.
    if (!estImage(file)) {
      rejected.push({ name: file.name, reason: `type non supporté (${file.type || 'inconnu'})` });
      continue;
    }
    if (file.size > MAX_BYTES) {
      rejected.push({
        name: file.name,
        reason: `trop volumineux (${Math.round(file.size / 1024 / 1024)} Mo)`,
      });
      continue;
    }

    try {
      await writeFile(
        join(dir, safeName(base + i + 1, file.name)),
        Buffer.from(await file.arrayBuffer()),
      );
      accepted += 1;
    } catch (err) {
      // Un fichier qui échoue n'emporte pas le paquet.
      log.error('écriture d’un fichier uploadé échouée', { file: file.name, err });
      rejected.push({ name: file.name, reason: String(err) });
    }
  }

  // `total` permet au client de dire exactement combien de pages ont atterri
  // quand un envoi casse en route : sans ce chiffre, on ne sait pas s'il faut
  // renvoyer le dossier — et le renvoyer en entier doublerait l'inventaire.
  const total = await nextRank(dir);

  return NextResponse.json({ sessionId, session: sessionName, accepted, rejected, total });
}

/**
 * Fin du lot : enfile l'appariement.
 *
 * Séparé du dépôt parce qu'apparier demande de voir TOUT le lot — on ne peut pas
 * savoir qu'une image est un dos en la regardant seule.
 */
export async function PUT(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    session?: string;
    mode?: string;
    expected?: number | null;
  };
  const sessionName = String(body.session ?? '').trim();
  const mode = body.mode === 'front_only' ? 'front_only' : 'duplex';
  const expected =
    typeof body.expected === 'number' && Number.isInteger(body.expected) && body.expected >= 0
      ? body.expected
      : null;

  if (sessionName.length === 0) {
    return NextResponse.json({ error: 'nom de session requis' }, { status: 400 });
  }

  const { rows } = await query<{ id: string }>(
    `select id from sessions where name = $1 and status = 'open'`,
    [sessionName],
  );
  const sessionId = rows[0]?.id;
  if (!sessionId) {
    return NextResponse.json({ error: 'session introuvable' }, { status: 404 });
  }

  // Le comptage attendu, s'il a été saisi. Sans lui la réconciliation ne peut
  // rien vérifier, et l'écart de comptage est le SEUL signal d'une carte
  // physiquement scannée qui n'a pas de ligne d'inventaire (docs/02 §1).
  //
  // On ajoute au lieu d'écraser : un lot peut être envoyé en plusieurs fois,
  // et remplacer le total ferait basculer un lot correct en écart.
  if (expected !== null) {
    await query(
      `update sessions
          set expected_count = coalesce(expected_count, 0) + $2
        where id = $1`,
      [sessionId, expected],
    );
  }

  const dir = join(STORE, sessionName);
  // Clé d'idempotence sur le lot ET le mode : relancer une finalisation ne crée
  // pas un second job, mais changer de mode en crée bien un nouveau.
  const key = `pair_upload:${sessionId}:${mode}`;

  const { rows: job } = await query<{ id: string }>(
    `insert into jobs (type, payload, idempotency_key, priority)
     values ('pair_upload', $1, $2, 50)
     on conflict (idempotency_key) do nothing
     returning id`,
    [{ session_id: sessionId, dir, mode }, key],
  );

  log.info('appariement de lot enfilé', {
    session: sessionName,
    mode,
    enfile: job.length > 0,
  });

  return NextResponse.json({ sessionId, mode, queued: job.length > 0, expected });
}
