import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { query } from '../../../../../lib/db.js';
import { log } from '../../../../../lib/log.js';

/**
 * Sert l'image d'un scan à l'UI de review.
 *
 * Le chemin vient EXCLUSIVEMENT de la base, jamais de la requête : le client
 * fournit un uuid de scan, pas un chemin de fichier. C'est ce qui empêche de
 * transformer cette route en lecture arbitraire du disque.
 *
 * Ce n'est pas un appel externe (invariant 4) : c'est une lecture de fichier
 * local, au même titre que servir un asset.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
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

  try {
    const buf = await readFile(path);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'image/jpeg',
        // Le fichier ne change jamais pour un scan donné.
        'Cache-Control': 'private, max-age=86400, immutable',
      },
    });
  } catch (err) {
    // Jamais de catch vide : le fichier a pu être déplacé ou purgé.
    log.warn('image de scan illisible', { scan_id: id, err });
    return NextResponse.json({ error: 'image indisponible' }, { status: 404 });
  }
}
