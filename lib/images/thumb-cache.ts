import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log.js';

/**
 * Purge des vignettes de scan.
 *
 * La route `/api/scan/[id]/image` met en cache une vignette JPEG par scan, ~60 ko.
 * Rien ne les effaçait : à 25-50 000 cartes par mois, ça fait 1,5 à 3 Go par
 * mois, indéfiniment, sur le disque local — des dizaines de gigaoctets de
 * vignettes de cartes vendues depuis longtemps.
 *
 * Une vignette ne sert qu'à la review et à l'audit, c'est-à-dire pendant les
 * jours qui suivent le scan. Passé ce délai, elle se régénère à la demande en
 * quelques dizaines de millisecondes si on rouvre une vieille carte : la purge
 * ne perd donc rien, elle diffère un recalcul rare.
 */
const CACHE_DIR = process.env['THUMB_CACHE_DIR'] ?? './.thumb-cache';

export async function pruneThumbs(days = 30, dir = CACHE_DIR): Promise<number> {
  let noms: string[];
  try {
    noms = await readdir(dir);
  } catch {
    // Le répertoire n'existe pas encore : rien à purger, ce n'est pas une erreur.
    return 0;
  }

  const limite = Date.now() - days * 24 * 3600 * 1000;
  let supprimees = 0;

  for (const nom of noms) {
    if (!nom.endsWith('.jpg')) continue;
    const chemin = join(dir, nom);
    try {
      const s = await stat(chemin);
      if (s.mtimeMs >= limite) continue;
      await rm(chemin, { force: true });
      supprimees += 1;
    } catch (err) {
      // Un fichier qui résiste n'emporte pas la purge : elle repassera demain.
      log.debug('vignette non purgée', { chemin, err });
    }
  }

  if (supprimees > 0) {
    log.info('vignettes purgées', { supprimees, plus_vieilles_que_jours: days });
  }
  return supprimees;
}
