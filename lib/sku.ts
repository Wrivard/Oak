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

  return [card_id, variant, condition, language.toLowerCase()].join(SEP);
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

  return {
    card_id,
    variant: variant as CardVariant,
    condition: condition as CardCondition,
    language,
  };
}
