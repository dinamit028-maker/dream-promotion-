import Link from 'next/link';

/** an address that does not exist: Hebrew, with a way back (never the framework's English 404) */
export default function NotFound() {
  return (
    <main dir="rtl" className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
        <h1 className="font-display text-xl font-bold">הדף לא נמצא</h1>
        <p className="mt-2 text-muted">ייתכן שהקישור שגוי או ישן. אפשר לחזור למסך הבית ולהמשיך משם.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/dashboard" className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 font-semibold text-white">למסך הבית</Link>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 font-semibold">לדף הראשי</Link>
        </div>
      </div>
    </main>
  );
}
