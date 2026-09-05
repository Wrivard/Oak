/**
 * Le SEUL constructeur de SKU du codebase. Invariant 8 de CLAUDE.md.
 *
 * Aucune concaténation de SKU ailleurs. Le format est une clé primaire et une
 * clé d'appariement TCGplayer ; le jour où il change, il doit changer ici et
 * nulle part ailleurs.
 */
export type CardVariant =
  | 'normal'
  | 'holofoil'
  | 'reverseHolofoil'
  | '1stEditionNormal'
  | '1stEditionHolofoil'
  | 'unlimitedHolofoil'
  | 'promo';

export type CardCondition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export interface SkuParts {
  card_id: string;
  variant: CardVariant;
  condition: CardCondition;
  language: string;
}

const SEP = '-';

export const VARIANTS: readonly CardVariant[] = [
  'normal',
  'holofoil',
  'reverseHolofoil',
  '1stEditionNormal',
  '1stEditionHolofoil',
  'unlimitedHolofoil',
  'promo',
];

export const CONDITIONS: readonly CardCondition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];

const EST_VARIANT = new Set<string>(VARIANTS);
const EST_CONDITION = new Set<string>(CONDITIONS);

/**
 * Format : {card_id}-{variant}-{condition}-{lang}
 *
 * card_id contient déjà des tirets ("base1-4", "swshp-SWSH284"). C'est sans
 * conséquence pour la construction, et le parsing se fait donc par la droite —
 * voir parseSku.
 */
export function buildSku(parts: SkuParts): string {
  const { card_id, variant, condition, language } = parts;

  if (!card_id) throw new Error('buildSku: card_id vide');
  if (!language) throw new Error('buildSku: language vide');

  // Le parsing se fait par la DROITE : les trois derniers segments sont
  // language, condition et variant. Un séparateur dans l'un des trois décale
  // donc tout — `pt-br` comme langue ferait lire « br » en langue, « pt » en
  // condition et « NM » en variant, et le SKU cesserait d'être une clé.
  // Le card_id, lui, a le droit d'en contenir : c'est ce que le parsing par la
  // droite absorbe.
  const lang = language.toLowerCase();
  if (lang.includes(SEP)) {
    throw new Error(`buildSku: la langue ne peut pas contenir « ${SEP} » (« ${lang} »)`);
  }
  if (!EST_VARIANT.has(variant)) throw new Error(`buildSku: variant inconnu « ${variant} »`);
  if (!EST_CONDITION.has(condition)) {
    throw new Error(`buildSku: condition inconnue « ${condition} »`);
  }

  return [card_id, variant, condition, lang].join(SEP);
}

/**
 * Inverse de buildSku. Découpe par la droite : les trois derniers segments sont
 * language, condition et variant ; tout ce qui reste à gauche est le card_id.
 */
export function parseSku(sku: string): SkuParts {
  const segments = sku.split(SEP);
  if (segments.length < 4) throw new Error(`parseSku: SKU malformé "${sku}"`);

  const language = segments.pop() as string;
  const condition = segments.pop() as string;
  const variant = segments.pop() as string;
  const card_id = segments.join(SEP);

  // On VALIDE au lieu de caster. Un cast rend un `CardVariant` qui n'en est pas
  // un, et l'erreur ressort plus loin sous une forme qui ne dit rien — par
  // exemple un prix cherché pour un printing qui n'existe pas.
  if (card_id === '') throw new Error(`parseSku: card_id vide dans "${sku}"`);
  if (!EST_VARIANT.has(variant)) {
    throw new Error(`parseSku: variant inconnu « ${variant} » dans "${sku}"`);
  }
  if (!EST_CONDITION.has(condition)) {
    throw new Error(`parseSku: condition inconnue « ${condition} » dans "${sku}"`);
  }

  return {
    card_id,
    variant: variant as CardVariant,
    condition: condition as CardCondition,
    language,
  };
}
