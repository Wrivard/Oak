import type { ReactNode } from 'react';

export const metadata = { title: 'pokelister' };

// Placeholder nu. Le système visuel arrive à l'étape 6 (docs/06-ui.md).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
