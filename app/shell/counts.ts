import { query } from '../../lib/db.js';

/**
 * Compteurs affichés en permanence dans la barre latérale.
 *
 * Une seule requête, volontairement : elle tourne sur CHAQUE page, et un
 * aller-retour supplémentaire par page se paie sur toute la session.
 *
 * En cas d'échec on rend des valeurs neutres plutôt que de faire tomber la
 * page : une base injoignable doit casser la page qui en a besoin, pas la
 * navigation.
 */
export interface ShellCounts {
  review: number;
  health: 'ok' | 'warn' | 'alarm';
}

export async function loadShellCounts(): Promise<ShellCounts> {
  try {
    const { rows } = await query<{ review: string; dead: string }>(
      `select
         (select count(*) from scans where status = 'needs_review')::text as review,
         (select count(*) from jobs
           where status = 'dead' and created_at > now() - interval '24 hours')::text as dead`,
    );
    const review = Number(rows[0]?.review ?? 0);
    const dead = Number(rows[0]?.dead ?? 0);

    return {
      review,
      // Un job mort ne se rejoue jamais tout seul : c'est une alarme, pas un
      // avertissement. Voir docs/05 §1.2.
      health: dead > 0 ? 'alarm' : review > 2400 ? 'warn' : 'ok',
    };
  } catch {
    return { review: 0, health: 'warn' };
  }
}
