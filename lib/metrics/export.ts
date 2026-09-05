/**
 * Le dernier export TCGplayer, vu depuis le tableau de santé.
 *
 * L'export tourne par cron et écrit un CSV. Quand il écarte tout — aujourd'hui
 * parce que `tcg_sku_id` est vide sur tout l'inventaire — il produit un fichier
 * VIDE, note le détail dans `channel_events`, et rien à l'écran ne le dit. On
 * peut donc téléverser un fichier sans lignes des jours durant en croyant
 * pousser son stock.
 *
 * L'écart n'est pas une erreur en soi : une carte sans `tcg_sku_id` ne PEUT pas
 * être exportée, et l'inventer serait pire. Ce qui manque, c'est de le voir.
 */
export interface ExportRun {
  /** Date ISO du dernier export, ou null si aucun n'a jamais tourné. */
  at: string | null;
  lignes: number;
  ecartees: number;
  /** Compte par raison, tel qu'écrit dans channel_events. */
  detail: Record<string, number>;
}

export interface ExportMetric {
  value: string;
  detail: string;
  health: 'ok' | 'warn' | 'alarm';
}

function raisons(detail: Record<string, number>): string {
  const parts = Object.entries(detail)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`);
  return parts.length > 0 ? parts.join(' · ') : 'raison non détaillée';
}

export function computeExport(run: ExportRun | null): ExportMetric {
  if (run === null || run.at === null) {
    return {
      value: '—',
      detail: 'aucun export encore généré',
      health: 'ok',
    };
  }

  const total = run.lignes + run.ecartees;

  // Rien à exporter du tout : l'inventaire est vide, ce n'est pas un problème.
  if (total === 0) {
    return { value: '0', detail: `${run.at} · inventaire vide`, health: 'ok' };
  }

  // Tout écarté : le fichier est vide et le téléverser ne pousse rien.
  if (run.lignes === 0) {
    return {
      value: '0',
      detail: `${run.at} · ${run.ecartees} écartée${run.ecartees > 1 ? 's' : ''}, fichier VIDE — ${raisons(run.detail)}`,
      health: 'alarm',
    };
  }

  if (run.ecartees > 0) {
    return {
      value: String(run.lignes),
      detail: `${run.at} · ${run.ecartees} écartée${run.ecartees > 1 ? 's' : ''} — ${raisons(run.detail)}`,
      health: 'warn',
    };
  }

  return {
    value: String(run.lignes),
    detail: `${run.at} · tout l'inventaire exportable est passé`,
    health: 'ok',
  };
}
