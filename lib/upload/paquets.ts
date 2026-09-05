/**
 * Découpe un lot de fichiers en paquets d'envoi.
 *
 * Le découpage se faisait par NOMBRE, dix fichiers par requête. À 500 ko la
 * photo — un JPEG 300 dpi — ça fait 5 Mo par requête, sans problème. À 20 Mo la
 * photo — un TIFF 600 dpi, ce que sort le pilote par défaut de beaucoup de
 * scanners, et la limite par fichier est de 25 Mo — ça fait **200 Mo par
 * requête**, tamponnés des deux côtés. Le process Next tombe, et l'envoi
 * s'arrête au milieu du lot.
 *
 * On borne donc les deux : un plafond d'octets ET un plafond de fichiers. Un
 * fichier plus gros que le plafond part seul plutôt que d'être refusé — c'est la
 * route qui décide ce qui est trop gros, pas le découpage.
 */
export const MAX_OCTETS_PAR_PAQUET = 16 * 1024 * 1024;
export const MAX_FICHIERS_PAR_PAQUET = 10;

export interface Decoupable {
  size: number;
}

export function enPaquets<T extends Decoupable>(
  fichiers: readonly T[],
  maxOctets = MAX_OCTETS_PAR_PAQUET,
  maxFichiers = MAX_FICHIERS_PAR_PAQUET,
): T[][] {
  const paquets: T[][] = [];
  let courant: T[] = [];
  let octets = 0;

  for (const f of fichiers) {
    // Un paquet vide accepte n'importe quelle taille : sinon un seul fichier
    // au-dessus du plafond ne partirait jamais et le lot resterait bloqué.
    const depasse =
      courant.length > 0 &&
      (courant.length >= maxFichiers || octets + f.size > maxOctets);

    if (depasse) {
      paquets.push(courant);
      courant = [];
      octets = 0;
    }

    courant.push(f);
    octets += f.size;
  }

  if (courant.length > 0) paquets.push(courant);
  return paquets;
}
