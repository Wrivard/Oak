import AutoRefresh from './auto-refresh.js';
import { loadMetrics, type Health } from './queries.js';

/**
 * Le dashboard qui compte. Voir docs/05-production.md §1.2.
 * Cinq métriques, une page. Si elle est verte, on peut aller dormir.
 */
export const dynamic = 'force-dynamic';

const LIBELLE: Record<Health, string> = {
  ok: 'Tout va bien',
  warn: 'À surveiller',
  alarm: 'Alarme',
};

export default async function DashboardPage() {
  const metrics = await loadMetrics();
  const worst: Health = metrics.some((m) => m.health === 'alarm')
    ? 'alarm'
    : metrics.some((m) => m.health === 'warn')
      ? 'warn'
      : 'ok';

  return (
    <>
      <AutoRefresh />
      <header className="page-head">
        <h1 className="page-title">Santé du pipeline</h1>
        <span className="page-actions">
          <span className={`dot dot--${worst}`} />
          <span className="label" style={{ color: `var(--${worst === 'ok' ? 'green' : worst === 'warn' ? 'amber' : 'red'})` }}>
            {LIBELLE[worst]}
          </span>
        </span>
      </header>

      <div className="page-body">
        <div className="narrow" style={{ display: 'grid', gap: 'var(--s3)' }}>
          {metrics.map((m) => (
            <article
              key={m.label}
              className="panel"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 'var(--s4)',
                alignItems: 'center',
                borderLeft: `2px solid var(--${m.health === 'ok' ? 'border' : m.health === 'warn' ? 'amber' : 'red'})`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{m.label}</div>
                <div className="dim mono" style={{ marginTop: 2 }}>
                  {m.detail}
                </div>
                {/* Le seuil est affiché : une alarme dont on ignore le
                    déclencheur finit par être ignorée. */}
                <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                  alarme si {m.threshold}
                </div>
              </div>
              <div
                className="num"
                style={{
                  fontSize: 26,
                  color:
                    m.health === 'ok'
                      ? 'var(--text)'
                      : m.health === 'warn'
                        ? 'var(--amber)'
                        : 'var(--red)',
                }}
              >
                {m.value}
              </div>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}
