import type { NextConfig } from 'next';

/**
 * Le worker est en `moduleResolution: NodeNext` : ses imports portent une
 * extension `.js` obligatoire, y compris vers les modules partagés de `lib/`.
 * Le bundler de Next ne fait pas ce mapping tout seul et échoue sur
 * `Can't resolve '../../lib/db.js'`.
 *
 * `extensionAlias` réconcilie les deux sans dégrader les imports du worker, qui
 * doivent rester valides pour Node en ESM natif.
 */
const config: NextConfig = {
  // Invariant 4 : aucune requête HTTP ne fait d'appel externe. Rien à proxifier.
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  // `sharp` et `onnxruntime` chargent des binaires natifs : ils ne doivent
  // jamais être bundlés côté serveur.
  serverExternalPackages: ['sharp', '@xenova/transformers', 'tesseract.js', 'pg'],

  turbopack: {
    resolveAlias: {},
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
  },

  webpack: (cfg) => {
    cfg.resolve.extensionAlias = {
      ...cfg.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return cfg;
  },
};

export default config;
