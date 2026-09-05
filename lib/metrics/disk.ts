/**
 * La taille de la base contre le quota du plan.
 *
 * Ce n'est pas une métrique de confort. Au-delà du quota, Supabase passe la base
 * en LECTURE SEULE : les uploads échouent, l'inventaire ne bouge plus, le worker
 * meurt sur `cannot execute INSERT in a read-only transaction`. Le pipeline
 * s'arrête net. Ce n'est pas un ralentissement, c'est un mur, et rien dans
 * l'application ne le voyait venir.
 *
 * Mesuré le 5 septembre 2026 : une empreinte coûte ~2,9 ko une fois l'index
 * HNSW inutile retiré (migration 009), et `known_fingerprints` gagne UNE LIGNE
 * PAR SCAN RÉSOLU. `cards` et `card_embeddings` occupent déjà 121 Mo des
 * 500 Mo du plan gratuit. Reste ~379 Mo, soit environ 131 000 empreintes —
 * trois à cinq mois à 25-50 000 cartes par mois.
 *
 * Les seuils sont donc bas volontairement : à 80 % il reste des semaines pour
 * agir, à 95 % il reste des jours.
 */
export const QUOTA_DEFAUT_MO = 500;

export interface DiskMetric {
  value: string;
  detail: string;
  health: 'ok' | 'warn' | 'alarm';
}

export function computeDisk(octets: number, quotaMo = QUOTA_DEFAUT_MO): DiskMetric {
  const mo = octets / (1024 * 1024);
  const part = mo / quotaMo;
  const reste = Math.max(0, quotaMo - mo);

  const value = `${Math.round(part * 100)} %`;
  const base = `${mo.toFixed(0)} Mo sur ${quotaMo} · ${reste.toFixed(0)} Mo libres`;

  if (part >= 0.95) {
    return {
      value,
      detail: `${base} — la base passe en LECTURE SEULE au quota : plus aucun scan, plus aucune vente enregistrée`,
      health: 'alarm',
    };
  }
  if (part >= 0.8) {
    return {
      value,
      detail: `${base} — au quota, la base passe en lecture seule et le pipeline s’arrête`,
      health: 'warn',
    };
  }
  return { value, detail: base, health: 'ok' };
}
