import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { query } from '../../../../../lib/db.js';
import { log } from '../../../../../lib/log.js';

/**
 * Sert l'image d'un scan à l'UI de review.
 *
 * Le chemin vient EXCLUSIVEMENT de la base, jamais de la requête : le client
 * fournit un uuid de scan, pas un chemin de fichier. C'est ce qui empêche de
 * transformer cette route en lecture arbitraire du disque.
 *
 * VIGNETTE PAR DÉFAUT. Mesuré : les scans font 575 Ko à 1,1 Mo et la review les
 * affiche dans 340 px. Servir l'original, c'est un mégaoctet transféré et
 * décodé pour chaque carte — sur un budget de 3 secondes par carte, ça se voit.
 * La vignette tombe autour de 60 Ko, soit 10 à 15 fois moins.
 *
 * `?full=1` sert l'original, pour qui veut inspecter un défaut de surface.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 2× la largeur d'affichage : net sur un écran à haute densité. */
const THUMB_WIDTH = 700;
const THUMB_QUALITY = 80;
const CACHE_DIR = process.env['THUMB_CACHE_DIR'] ?? './.thumb-cache';

async function thumbnail(id: string, path: string): Promise<Buffer> {
  const cached = join(CACHE_DIR, `${id}.jpg`);
  try {
    return await readFile(cached);
  } catch {
    // Pas encore générée.
  }

  const buf = await sharp(await readFile(path))
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();

  // Le cache est un confort, pas une garantie : s'il échoue on sert quand même.
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cached, buf);
  } catch (err) {
    log.debug('vignette non mise en cache', { scan_id: id, err });
  }

  return buf;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'id invalide' }, { status: 400 });
  }

  const { rows } = await query<{ front_path: string }>(
    'select front_path from scans where id = $1',
    [id],
  );
  const path = rows[0]?.front_path;
  if (!path) return NextResponse.json({ error: 'scan introuvable' }, { status: 404 });

  const full = new URL(req.url).searchParams.get('full') === '1';

  try {
    const buf = full ? await readFile(path) : await thumbnail(id, path);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'image/jpeg',
        // Le fichier ne change jamais pour un scan donné : le navigateur peut
        // le garder, ce qui rend le retour en arrière instantané.
        'Cache-Control': 'private, max-age=86400, immutable',
      },
    });
  } catch (err) {
    // Jamais de catch vide : le fichier a pu être déplacé ou purgé.
    log.warn('image de scan illisible', { scan_id: id, err });
    return NextResponse.json({ error: 'image indisponible' }, { status: 404 });
  }
}
