'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * Coquille de l'application. Voir docs/06-ui.md.
 *
 * La barre latérale se réduit à un rail d'icônes, et se réduit d'elle-même sur
 * `/review` : c'est la page qui a besoin de toute la largeur, et le budget de
 * 3 secondes par carte ne supporte pas de perdre 200 px à de la navigation
 * qu'on ne regarde pas pendant qu'on trie.
 */
interface Counts {
  review: number;
  health: 'ok' | 'warn' | 'alarm';
}

interface Props {
  counts: Counts;
  children: ReactNode;
}

const ICONS: Record<string, ReactNode> = {
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 16V4m0 0L7 9m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 9h8M8 13h5" strokeLinecap="round" />
    </svg>
  ),
  pricing: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v18" strokeLinecap="round" />
      <path
        d="M16 7.5c0-1.4-1.8-2.5-4-2.5s-4 1.1-4 2.5S9.8 10 12 10s4 1.1 4 2.5S14.2 15 12 15s-4-1.1-4-2.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  inventory: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7Z" strokeLinejoin="round" />
      <path d="M3 7l9 4 9-4M12 11v10" strokeLinejoin="round" />
    </svg>
  ),
  batches: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </svg>
  ),
  diagnostics: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" strokeLinecap="round" />
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" strokeLinecap="round" />
    </svg>
  ),
};

const NAV = [
  { href: '/upload', label: 'Envoyer', icon: 'upload' },
  { href: '/batches', label: 'Lots', icon: 'batches' },
  { href: '/review', label: 'Review', icon: 'review' },
  { href: '/inventory', label: 'Inventaire', icon: 'inventory' },
  { href: '/pricing', label: 'Prix', icon: 'pricing' },
  { href: '/diagnostics', label: 'Diagnostic', icon: 'diagnostics' },
  { href: '/dashboard', label: 'Santé', icon: 'dashboard' },
] as const;

export default function Shell({ counts, children }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('shell.collapsed');
      if (stored !== null) {
        setCollapsed(stored === '1');
        setManual(true);
      }
    } catch {
      // Stockage bloqué : on garde le comportement automatique.
    }
  }, []);

  // La review veut toute la largeur. Tant que l'utilisateur n'a pas exprimé de
  // préférence, on décide pour lui ; dès qu'il l'a fait, on la respecte.
  const isReview = pathname === '/review';
  const shown = manual ? collapsed : isReview;

  function toggle() {
    const next = !shown;
    setCollapsed(next);
    setManual(true);
    try {
      localStorage.setItem('shell.collapsed', next ? '1' : '0');
    } catch {
      // Préférence de confort : sans stockage, elle vaut pour la session.
    }
  }

  return (
    <div className="shell" data-collapsed={shown}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden />
          <span className="sidebar-name">pokelister</span>
        </div>

        <nav className="sidebar-nav">
          {NAV.map((item) => {
            const active = pathname === item.href;
            const badge =
              item.href === '/review' && counts.review > 0
                ? String(counts.review)
                : null;

            return (
              <Link
                key={item.href}
                href={item.href}
                className="nav-item"
                title={item.label}
                {...(active ? { 'aria-current': 'page' as const } : {})}
              >
                {ICONS[item.icon]}
                <span className="nav-label">{item.label}</span>
                {badge && (
                  <span className="nav-badge" data-tone={counts.review > 500 ? 'alert' : undefined}>
                    {badge}
                  </span>
                )}
                {item.href === '/dashboard' && (
                  <span className={`dot dot--${counts.health}`} aria-hidden />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button className="collapse-btn" onClick={toggle} title="Réduire le menu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="17" height="17">
              <path
                d={shown ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="collapse-label">Réduire</span>
          </button>
        </div>
      </aside>

      <div className="main">{children}</div>
    </div>
  );
}
