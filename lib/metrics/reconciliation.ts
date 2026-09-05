/**
 * L'état de la réconciliation, calculé à part de sa requête.
 *
 * Le pire bug possible du système est SILENCIEUX : une double-alimentation du
 * scanner fait exister une carte physique sans ligne d'inventaire. On ne la
 * vend pas, on ne la retrouve jamais, et l'écart de comptage est le seul signal
 * qu'elle a existé (docs/02 §1).
 *
 * D'où le point qui compte ici : **l'absence d'écart et l'absence de contrôle
 * ne sont pas la même chose.** La métrique disait « toutes les sessions
 * balancent » alors qu'aucun lot ouvert n'avait de comptage attendu — c'est-à-
 * dire pendant que le contrôle était purement et simplement inactif. Une
 * fausse assurance sur exactement le point qu'on ne peut pas rattraper plus
 * tard.
 *
 * L'upload n'a pas de compteur de feuilles : `expected_count` reste nul tant
 * qu'on ne saisit pas à la main le nombre de cartes mises dans le scanner. Le
 * cas « non vérifiable » est donc le cas NORMAL, pas un cas limite.
 */
export interface SessionCount {
  name: string;
  expected: number | null;
  scanned: number;
}

export interface Reconciliation {
  value: string;
  detail: string;
  health: 'ok' | 'warn' | 'alarm';
}

export function computeReconciliation(ouvertes: readonly SessionCount[]): Reconciliation {
  if (ouvertes.length === 0) {
    return { value: '0', detail: 'aucun lot ouvert', health: 'ok' };
  }

  const ecarts = ouvertes.filter(
    (s) => s.expected !== null && s.expected !== s.scanned,
  );
  const sansCompte = ouvertes.filter((s) => s.expected === null);
  const verifies = ouvertes.length - sansCompte.length;

  // Un écart réel prime sur tout : c'est la carte qu'on est en train de perdre.
  if (ecarts.length > 0) {
    return {
      value: String(ecarts.length),
      detail: ecarts.map((s) => `${s.name} : ${s.scanned}/${s.expected ?? '?'}`).join(' · '),
      health: 'alarm',
    };
  }

  // Aucun écart ne veut rien dire si rien n'est vérifiable.
  if (verifies === 0) {
    return {
      value: '—',
      detail:
        `contrôle inactif : ${sansCompte.length} lot${sansCompte.length > 1 ? 's' : ''} ` +
        `ouvert${sansCompte.length > 1 ? 's' : ''} sans comptage attendu ` +
        `(${sansCompte.map((s) => s.name).join(', ')})`,
      health: 'warn',
    };
  }

  if (sansCompte.length > 0) {
    return {
      value: '0',
      detail:
        `${verifies} lot${verifies > 1 ? 's' : ''} balance${verifies > 1 ? 'nt' : ''} · ` +
        `${sansCompte.length} sans comptage attendu, non vérifiable${sansCompte.length > 1 ? 's' : ''}`,
      health: 'warn',
    };
  }

  return {
    value: '0',
    detail: `${verifies} lot${verifies > 1 ? 's' : ''} ouvert${verifies > 1 ? 's' : ''}, comptage vérifié`,
    health: 'ok',
  };
}
