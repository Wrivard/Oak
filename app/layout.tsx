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
 * Sur téléphone, la barre du navigateur prend cette couleur.
 *
 * Sans elle, elle reste blanche au-dessus d'une application entièrement sombre —
 * une bande claire en haut de l'écran, exactement là où on regarde en triant. Le
 * cas n'est pas théorique : le lanceur affiche l'adresse réseau justement pour
 * reviewer depuis un téléphone.
 */
export const viewport = {
  // La MÊME valeur que `--bg` dans globals.css. Elle était restée à #171717,
  // la couleur d'avant la refonte de la palette : la barre du navigateur
  // tombait à côté du fond de l'application d'un ton, ce qui se voit
  // exactement comme une jointure mal faite.
  themeColor: '#0f1113',
};

/**
 * La coquille enveloppe toutes les pages : la navigation ne se recharge pas
 * quand on change d'écran, et les compteurs restent visibles en permanence.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const counts = await loadShellCounts();

  return (
    <html lang="fr">
      <head>
        {/* La police du corps de texte est préchargée : sans ça, le navigateur
            ne la découvre qu'après avoir analysé la feuille de style, et la
            première page s'affiche en Segoe avant de basculer sous les yeux.
            Seul le sous-ensemble latin est préchargé — l'étendu ne sert qu'à
            quelques caractères et peut arriver après. */}
        <link
          rel="preload"
          href="/fonts/inter-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Shell counts={counts}>{children}</Shell>
      </body>
    </html>
  );
}
