import Link from 'next/link';
import { loadMetrics, type Health } from './queries.js';

/**
 * Le dashboard qui compte. Voir docs/05-production.md §1.2.
 *
 * Cinq métriques, une page. Si elle est verte, on peut aller dormir.
 */
export const dynamic = 'force-dynamic';

const COLOR: Record<Health, string> = {
  ok: 'var(--green)',
  warn: 'var(--amber)',
  alarm: 'var(--red)',
};

export default async function DashboardPage() {
  const metrics = await loadMetrics();
  const worst: Health = metrics.some((m) => m.health === 'alarm')
    ? 'alarm'
    : metrics.some((m) => m.health === 'warn')
      ? 'warn'
      : 'ok';

  return (
    <main style={{ padding: 'var(--s5)', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s3)' }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Santé du pipeline</h1>
        <span className="mono" style={{ color: COLOR[worst], fontSize: 12, fontWeight: 600 }}>
          {worst === 'ok' ? 'TOUT VERT' : worst === 'warn' ? 'À SURVEILLER' : 'ALARME'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          <Link href="/review" style={{ color: 'var(--green)' }}>review</Link>
          {' · '}
          <Link href="/pricing" style={{ color: 'var(--green)' }}>prix</Link>
        </span>
      </div>

      <div style={{ display: 'grid', gap: 'var(--s2)', marginTop: 'var(--s4)' }}>
        {metrics.map((m) => (
          <div
            key={m.label}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 'var(--s3)',
              alignItems: 'baseline',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderLeft: `3px solid ${COLOR[m.health]}`,
              borderRadius: 'var(--s2)',
              padding: 'var(--s3)',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{m.label}</div>
              <div className="dim mono" style={{ fontSize: 12, marginTop: 2 }}>
                {m.detail}
              </div>
              {/* Le seuil est affiché : une alarme dont on ignore le déclencheur
                  finit par être ignorée. */}
              <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                alarme si {m.threshold}
              </div>
            </div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: COLOR[m.health] }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
