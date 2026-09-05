'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Rafraîchit les données du dashboard sans recharger la page.
 *
 * Un `<meta refresh>` rechargerait aussi la barre latérale et ferait clignoter
 * tout l'écran. `router.refresh()` ne renouvelle que les données serveur : les
 * chiffres bougent, rien ne saute.
 */
export default function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return null;
}
