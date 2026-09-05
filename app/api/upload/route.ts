import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { query } from '../../../lib/db.js';
import { log } from '../../../lib/log.js';
import { openSession } from '../../../lib/ingest/register.js';
import type { CardCondition, CardVariant } from '../../../lib/sku.js';

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

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Le nom du fichier PORTE L'ORDRE, et l'ordre porte l'appariement recto/verso.
 * On ne réutilise jamais le nom original : il vient de l'utilisateur et pourrait
 * sortir du répertoire.
 */
function safeName(rank: number, original: string): string {
  const ext = /\.(jpe?g|png|webp|tiff?)$/i.exec(original)?.[0]?.toLowerCase() ?? '.jpg';
  return `${String(rank).padStart(6, '0')}${ext}`;
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

  if (sessionName.length === 0) {
    return NextResponse.json({ error: 'nom de session requis' }, { status: 400 });
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
    if (!ACCEPTED.has(file.type)) {
      rejected.push({ name: file.name, reason: `type non supporté (${file.type})` });
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

  return NextResponse.json({ sessionId, session: sessionName, accepted, rejected });
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
  };
  const sessionName = String(body.session ?? '').trim();
  const mode = body.mode === 'front_only' ? 'front_only' : 'duplex';

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

  return NextResponse.json({ sessionId, mode, queued: job.length > 0 });
}
