import Link from 'next/link';

/**
 * Il n'y a qu'une page qui compte. Celle-ci n'existe que pour y mener.
 */
export default function Home() {
  return (
    <main style={{ padding: 'var(--s6)' }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>pokelister</h1>
      <p className="dim" style={{ marginTop: 'var(--s2)' }}>
        <Link href="/review" style={{ color: 'var(--green)' }}>
          File de review
        </Link>
      </p>
    </main>
  );
}
