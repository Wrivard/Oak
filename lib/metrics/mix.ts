/**
 * La métrique économique principale du projet, isolée de sa requête.
 *
 * La part `manual` devrait descendre avec le temps, jamais monter : c'est le
 * seul coût marginal par carte qui reste, et il se paie en minutes.
 *
 * ELLE SE CALCULE SUR CE QUI A ÉTÉ DÉCIDÉ, pas sur tout ce qui est entré.
 *
 * Compter les scans encore en review comme du manuel met la métrique en alarme
 * dès le premier lot envoyé, et l'y laisse tant que la review n'est pas vidée.
 * À 1 700 cartes par jour, l'alarme est allumée en permanence — et une alarme
 * toujours allumée n'est plus une alarme : on apprend à ne plus la regarder, y
 * compris le jour où elle a raison.
 *
 * L'arriéré n'est pas perdu pour autant : il a sa PROPRE métrique, « Cartes en
 * review », avec son seuil sur la capacité quotidienne. Mélanger les deux
 * détruisait le signal des deux.
 *
 * Le calcul vit ici, séparé du SQL, parce que c'est LE calcul qui était faux.
 */
export const MANUAL_RATE_ALARM = 0.15;
export const MANUAL_RATE_WARN = 0.1;

export interface MixCounts {
  own: number;
  catalog: number;
  manual: number;
  /** Scans entrés mais pas encore décidés. Ils ne comptent pas dans le taux. */
  attente: number;
}

export interface Mix {
  /** `null` tant que rien n'a été décidé : un taux sur zéro ne veut rien dire. */
  rate: number | null;
  decides: number;
  health: 'ok' | 'warn' | 'alarm';
  value: string;
  detail: string;
}

export function computeMix({ own, catalog, manual, attente }: MixCounts): Mix {
  const decides = own + catalog + manual;

  if (decides === 0) {
    return {
      rate: null,
      decides: 0,
      health: 'ok',
      value: '—',
      detail:
        attente === 0
          ? 'aucun scan sur la période'
          : `rien de décidé encore · ${attente} en attente de review`,
    };
  }

  const rate = manual / decides;
  return {
    rate,
    decides,
    health:
      rate > MANUAL_RATE_ALARM ? 'alarm' : rate > MANUAL_RATE_WARN ? 'warn' : 'ok',
    value: `${Math.round(rate * 100)} % manuel`,
    detail:
      `own_history ${own} · catalog ${catalog} · manuel ${manual} · décidés ${decides}` +
      (attente > 0 ? ` · ${attente} en attente` : ''),
  };
}
