import type { ReactNode } from 'react';
import './globals.css';
import Shell from './shell/sidebar.js';
import { loadShellCounts } from './shell/counts.js';

export const metadata = {
  title: 'pokelister',
  description: 'Pipeline de listing Pokémon',
};

/**
 * La coquille enveloppe toutes les pages : la navigation ne se recharge pas
 * quand on change d'écran, et les compteurs restent visibles en permanence.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const counts = await loadShellCounts();

  return (
    <html lang="fr">
      <body>
        <Shell counts={counts}>{children}</Shell>
      </body>
    </html>
  );
}
