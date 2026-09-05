/**
 * Les extensions d'image reconnues, à un seul endroit.
 *
 * Elles étaient écrites trois fois : le filtre d'upload, le nommage sur disque
 * et le filtre d'appariement. Trois listes qui doivent s'accorder, et rien qui
 * le garantisse — en ajouter une à un seul endroit crée un fichier accepté que
 * l'appariement ignore, c'est-à-dire une carte scannée sans ligne d'inventaire.
 *
 * La liste n'est PAS la validation : le vrai filtre est sharp, qui échoue
 * visiblement sur ce qui n'est pas une image. Elle sert à reconnaître un fichier
 * dont le navigateur n'a pas su donner le type MIME — un `.tif` de scanner, le
 * plus souvent.
 */
export const EXTENSIONS_IMAGE = /\.(jpe?g|png|webp|tiff?|bmp)$/i;

/**
 * Extension à donner au fichier sur disque.
 *
 * Le nom d'origine vient de l'utilisateur et ne doit jamais servir tel quel :
 * il pourrait sortir du répertoire. On garde seulement l'extension, et `.jpg`
 * par défaut — ce qui est sans danger, puisque tout le reste du pipeline lit le
 * CONTENU du fichier, jamais son nom.
 */
export function extensionSure(nomOriginal: string): string {
  return EXTENSIONS_IMAGE.exec(nomOriginal)?.[0]?.toLowerCase() ?? '.jpg';
}
