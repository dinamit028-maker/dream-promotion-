/** 404 — inside the store's header and footer when the store is known; a neutral page (no platform name) when it is not */
export default function NotFound() {
  return (
    <div className="wrap not-found">
      <h1 className="page-title">הדף לא נמצא</h1>
      <p className="muted">ייתכן שהכתובת השתנתה או שהדף הוסר.</p>
      <p><a href="/" className="btn btn-ghost">לדף הבית</a></p>
    </div>
  );
}
