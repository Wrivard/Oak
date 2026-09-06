/**
 * L'avancement d'un envoi, en clair.
 *
 * Un lot d'ADF fait 80 feuilles ; un dossier de nuit en fait deux mille. À ce
 * volume, une barre qui avance sans chiffre ne dit pas si l'envoi prend trente
 * secondes ou dix minutes — et une opération dont on ignore la durée paraît
 * plus lente qu'elle ne l'est, quelle que soit sa vitesse réelle.
 *
 * Le débit est mesuré sur ce qui est DÉJÀ passé, jamais estimé d'avance : les
 * paquets sont bornés en octets, pas en nombre de fichiers, et un dossier de
 * scans TIFF n'avance pas au même rythme qu'un dossier de JPEG.
 */

export interface Progression {
  /** Entier 0-100. Ce qui remplit la barre. */
  pct: number;
  restantes: number;
  /**
   * Le temps restant en toutes lettres, ou `null` quand on ne sait pas encore.
   *
   * `null` n'est pas un défaut : afficher « 4 heures » parce que le premier
   * paquet a mis deux secondes est pire que ne rien afficher. On se tait tant
   * que la mesure ne vaut rien.
   */
  eta: string | null;
}

/** En dessous, le débit mesuré est du bruit : un seul paquet ne fait pas un rythme. */
const MESURE_MIN_MS = 1500;

export function progression(
  envoyees: number,
  total: number,
  ecouleMs: number,
): Progression {
  if (!Number.isFinite(total) || total <= 0) {
    return { pct: 0, restantes: 0, eta: null };
  }

  const faites = Math.min(Math.max(envoyees, 0), total);
  const restantes = total - faites;
  const pct = Math.round((100 * faites) / total);

  if (restantes === 0 || faites === 0 || ecouleMs < MESURE_MIN_MS) {
    return { pct, restantes, eta: null };
  }

  const parSeconde = faites / (ecouleMs / 1000);
  if (!Number.isFinite(parSeconde) || parSeconde <= 0) {
    return { pct, restantes, eta: null };
  }

  return { pct, restantes, eta: formatDuree(Math.ceil(restantes / parSeconde)) };
}

/**
 * Une durée qu'on lit sans la calculer.
 *
 * Pas de secondes au-delà de la minute : « ~3 min » se lit d'un coup d'oeil,
 * « ~3 min 47 s » demande de traiter deux nombres pour la même décision — celle
 * d'attendre devant l'écran ou non.
 */
function formatDuree(secondes: number): string {
  if (secondes <= 10) return 'quelques secondes';
  if (secondes < 60) return `~${Math.ceil(secondes / 5) * 5} s`;
  const minutes = Math.ceil(secondes / 60);
  if (minutes < 60) return `~${minutes} min`;
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  return reste === 0 ? `~${heures} h` : `~${heures} h ${reste} min`;
}
