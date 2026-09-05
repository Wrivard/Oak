/**
 * Le nom d'un lot devient un NOM DE RÉPERTOIRE.
 *
 * `join(STORE, nom)` avec un nom contenant `..` écrit hors du magasin. C'est
 * une route locale sur une machine à un seul utilisateur, mais un nom de lot se
 * tape à la main et un `../` de trop n'a aucune raison d'être une écriture
 * silencieuse ailleurs sur le disque.
 *
 * On REFUSE plutôt que de transformer : le nom sert aussi de clé de session et
 * s'affiche partout. Un lot silencieusement renommé serait pire que le refus —
 * on chercherait ses cartes sous un nom qui n'existe pas.
 *
 * La même fonction sert au client et à la route : le client désactive le bouton,
 * la route refuse la requête. Le client n'est jamais la sécurité, seulement le
 * confort de ne pas envoyer 2000 pages pour rien.
 */
const INTERDIT = /[/\\:*?"<>|]|^\.|\.\./;

/** Un caractère de contrôle dans un nom de fichier est toujours une erreur. */
function aUnCaractereDeControle(nom: string): boolean {
  for (let i = 0; i < nom.length; i++) {
    const c = nom.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

export const NOM_DE_LOT_MAX = 100;

/** `null` = valide. Sinon, la raison, écrite pour être affichée telle quelle. */
export function nomDeLotInvalide(nom: string): string | null {
  if (nom.length === 0) return 'nom de session requis';
  if (nom.length > NOM_DE_LOT_MAX) {
    return `nom de lot trop long (${NOM_DE_LOT_MAX} caractères maximum)`;
  }
  if (INTERDIT.test(nom) || aUnCaractereDeControle(nom)) {
    return 'nom de lot invalide : ni séparateur de chemin, ni « .. », ni caractère réservé';
  }
  return null;
}
