import { revalidatePath } from 'next/cache';
import { log } from '../lib/log.js';

/**
 * Rafraîchir un écran ne doit JAMAIS pouvoir faire échouer une écriture.
 *
 * `revalidatePath` lève hors d'un contexte de requête Next — en test, dans un
 * script, ou quand l'action est appelée d'une façon que Next n'attendait pas.
 * Appelé dans le `try` qui décide du succès, il transforme une transaction
 * commitée en échec rapporté à l'utilisateur.
 *
 * Ce n'est pas théorique : une correction d'inventaire réussissait, la
 * revalidation échouait, l'action rapportait un échec, et l'utilisateur qui
 * réessayait décrémentait la quantité une SECONDE fois.
 *
 * Règle : l'appel se fait après l'écriture, hors du try qui décide du succès, et
 * son échec ne remonte pas. Rafraîchir l'écran est un confort ; corriger
 * l'inventaire ne l'est pas.
 */
export function revalidateQuietly(path: string): void {
  try {
    revalidatePath(path);
  } catch (err) {
    log.debug('revalidation ignorée hors contexte de requête', { path, err });
  }
}
