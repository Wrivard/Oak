import type { NextConfig } from 'next';

const config: NextConfig = {
  // Invariant 4 : aucune requête HTTP ne fait d'appel externe. Rien à proxifier ici.
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default config;
