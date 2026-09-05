import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/db.js';
import { log } from '../../../lib/log.js';
import { nextSeq, openSession, registerScan } from '../../../lib/ingest/register.js';
import type { CardCondition, CardVariant } from '../../../lib/sku.js';

/**
 * Upload d'un lot de photos.
 *
 * Ce n'est PAS un appel externe (invariant 4) : on écrit un fichier local et une
 * ligne en base, puis on enfile un job. Tout le travail lourd — hachage,
 * embedding, OCR — reste dans le worker, parce qu'il prend des secondes par
 * carte et qu'une requête HTTP n'est pas l'endroit pour ça.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STORE = process.env['UPLOAD_DIR'] ?? './uploads';

/** Ce qu'un appareil photo ou un scanner produit raisonnablement. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);
const MAX_BYTES = 25 * 1024 * 1024;

function safeName(sessionName: string, seq: number, original: string): string {
  const ext = /\.(jpe?g|png|webp|tiff?)$/i.exec(original)?.[0] ?? '.jpg';
  // Le nom vient de nous, jamais du client : un nom fourni par l'utilisateur
  // qui atterrit dans un chemin de fichier est une traversée de répertoire.
  return `${String(seq).padStart(6, '0')}${ext.toLowerCase()}`;
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
  const files = form.getAll('files').filter((f): f is File => f instanceof File);

  if (sessionName.length === 0) {
    return NextResponse.json({ error: 'nom de session requis' }, { status: 400 });
  }
  if (files.length === 0) {
    return NextResponse.json({ error: 'aucun fichier' }, { status: 400 });
  }

  const sessionId = await openSession({ name: sessionName, variant, condition, language });
  const dir = join(STORE, sessionName);
  await mkdir(dir, { recursive: true });

  const accepted: { name: string; scanId: string }[] = [];
  const rejected: { name: string; reason: string }[] = [];

  const client = await getPool().connect();
  let seq: number;
  try {
    seq = await nextSeq(sessionId, client);
  } finally {
    client.release();
  }

  for (const file of files) {
    if (!ACCEPTED.has(file.type)) {
      rejected.push({ name: file.name, reason: `type non supporté (${file.type})` });
      continue;
    }
    if (file.size > MAX_BYTES) {
      rejected.push({ name: file.name, reason: `trop volumineux (${Math.round(file.size / 1024 / 1024)} Mo)` });
      continue;
    }

    try {
      const path = join(dir, safeName(sessionName, seq, file.name));
      // Le fichier est écrit AVANT la ligne : une ligne qui pointe sur un
      // fichier inexistant ferait échouer le handler fingerprint.
      await writeFile(path, Buffer.from(await file.arrayBuffer()));

      const { scanId } = await registerScan({ sessionId, seq, frontPath: path });
      accepted.push({ name: file.name, scanId });
      seq += 1;
    } catch (err) {
      // Un fichier qui échoue n'emporte pas le lot.
      log.error('upload d’un fichier échoué', { file: file.name, err });
      rejected.push({ name: file.name, reason: String(err) });
    }
  }

  log.info('lot uploadé', {
    session: sessionName,
    acceptes: accepted.length,
    rejetes: rejected.length,
  });

  return NextResponse.json({
    sessionId,
    session: sessionName,
    accepted: accepted.length,
    rejected,
  });
}
