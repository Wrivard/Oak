'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Rafraîchit les données SERVEUR d'un écran sans recharger la page.
 *
 * Il vivait sous `app/dashboard/` et trois écrans l'importaient de là :
 * importer un composant « dashboard » dans l'écran d'envoi dit quelque chose de
 * faux sur ce qu'il fait.
 *
 * Un `<meta refresh>` rechargerait aussi la barre latérale et ferait clignoter
 * tout l'écran. `router.refresh()` ne renouvelle que les données serveur : les
 * chiffres bougent, rien ne saute.
 *
 * ONGLET CACHÉ, RIEN. C'est l'écran qu'on laisse ouvert pendant qu'un lot
 * tourne, puis toute la journée : sans cette garde, `/batches` seul relance sa
 * requête et celle de la coquille 8 600 fois par jour pour personne. Au retour
 * sur l'onglet, on rafraîchit UNE fois — sinon on regarderait un écran périmé
 * en croyant le contraire, ce qui est pire que pas de rafraîchissement du tout.
 */
export default function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const visible = (): boolean =>
      typeof document === 'undefined' || document.visibilityState === 'visible';

    const id = setInterval(() => {
      if (visible()) router.refresh();
    }, seconds * 1000);

    const onVisible = (): void => {
      if (visible()) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, seconds]);

  return null;
}
