import type { ReactNode } from 'react';
import './globals.css';
import Shell from './shell/sidebar.js';
import { loadShellCounts } from './shell/counts.js';

export const metadata = {
  // Le titre est PRÉFIXÉ par l'écran : huit onglets ouverts qui disent tous
  // « pokelister » ne se distinguent pas, et c'est l'usage réel — on laisse les
  // lots, la review et la santé ouverts en même temps.
  title: { default: 'pokelister', template: '%s · pokelister' },
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
