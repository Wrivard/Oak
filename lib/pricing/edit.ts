import type { Band, PricingConfig } from './rules.js';

/**
 * Les manipulations de bandes de l'éditeur, isolées et pures.
 *
 * Elles vivent hors du composant parce qu'elles portent un invariant que
 * `parsePricingConfig` refuse de voir violé : **la dernière bande n'a pas de
 * plafond**. Sans elle, une carte plus chère que la dernière borne ne tombe
 * dans aucune bande, `find` rend `undefined`, et le prix est calculé sur du
 * vide — en production, sur les cartes qui valent le plus cher.
 *
 * Un bouton « ajouter » qui empilerait naïvement une bande à la fin casserait
 * ça d'un clic. Ces fonctions sont donc testées, pas relues.
 */

/** Copie profonde. Les mutations ne touchent jamais l'objet d'origine. */
function clone(cfg: PricingConfig): PricingConfig {
  return JSON.parse(JSON.stringify(cfg)) as PricingConfig;
}

/**
 * Trie les bandes par borne croissante, la bande sans plafond toujours dernière.
 *
 * L'ordre EST la sémantique : les bandes se lisent de la première à la
 * dernière, et une borne plus basse que la précédente rendrait la bande
 * inatteignable — silencieusement.
 */
export function trierBandes(bands: Band[]): Band[] {
  return [...bands].sort((a, b) =>
    a.up_to === null ? 1 : b.up_to === null ? -1 : a.up_to - b.up_to,
  );
}

/**
 * Insère une bande AVANT la dernière, avec une borne qui double la précédente.
 *
 * Doubler plutôt que reprendre la borne précédente : deux bandes de même borne
 * en rendent une inatteignable.
 */
export function ajouterBande(cfg: PricingConfig): PricingConfig {
  const next = clone(cfg);
  const avant = next.bands[next.bands.length - 2] ?? next.bands[0];
  const seuil = avant?.up_to ?? 1;
  next.bands.splice(next.bands.length - 1, 0, {
    up_to: seuil * 2,
    mode: 'mult',
    value: 1.1,
    round: 'psych',
  });
  next.bands = trierBandes(next.bands);
  return next;
}

/**
 * Retire une bande. La dernière est intouchable : la retirer laisserait les
 * cartes chères sans bande.
 */
export function retirerBande(cfg: PricingConfig, index: number): PricingConfig {
  if (index < 0 || index >= cfg.bands.length) return cfg;
  if (index === cfg.bands.length - 1) return cfg;
  const next = clone(cfg);
  next.bands.splice(index, 1);
  return next;
}

/** Change la borne d'une bande, puis remet l'ordre. */
export function changerBorne(cfg: PricingConfig, index: number, borne: number): PricingConfig {
  const next = clone(cfg);
  const cible = next.bands[index];
  if (!cible || cible.up_to === null) return cfg;
  cible.up_to = Math.max(0.01, borne);
  next.bands = trierBandes(next.bands);
  return next;
}

/**
 * Change le mode d'une bande.
 *
 * La valeur est réinitialisée avec le changement : un multiplicateur et un
 * plancher ne vivent pas dans les mêmes ordres de grandeur. Garder 1,15 en
 * passant en mode plancher publierait toutes les cartes de la bande à 1,15 $.
 */
export function changerMode(cfg: PricingConfig, index: number, mode: Band['mode']): PricingConfig {
  const next = clone(cfg);
  const cible = next.bands[index];
  if (!cible) return cfg;
  cible.mode = mode;
  cible.value = mode === 'floor' ? next.hard_floor : 1.1;
  return next;
}
