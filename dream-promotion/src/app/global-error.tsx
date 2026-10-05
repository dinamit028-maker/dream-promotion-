'use client';
import { useEffect } from 'react';

/**
 * The last safety net: the root layout itself failed, so this page brings its own <html> and plain styles (the app's
 * stylesheet may not be there). Hebrew, right to left, never a white page.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const btn = { minHeight: 44, padding: '0 20px', borderRadius: 999, border: '1px solid #c9c2dc', background: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer' } as const;
  return (
    <html lang="he" dir="rtl">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f6f4fb', color: '#1d1530' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div role="alert" style={{ maxWidth: 420, width: '100%', background: '#fff', borderRadius: 16, padding: 24, textAlign: 'center', boxShadow: '0 6px 24px rgba(0,0,0,.08)' }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>משהו השתבש</h1>
            <p style={{ color: '#5b5470', lineHeight: 1.6 }}>האפליקציה לא נטענה כמו שצריך. מה שכבר נשמר — נשמר ולא נמחק. אפשר לנסות שוב או לרענן את הדף.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={reset} style={{ ...btn, background: '#6b3bf5', color: '#fff', border: 'none' }}>לנסות שוב</button>
              <button type="button" onClick={() => window.location.reload()} style={btn}>רענון הדף</button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
