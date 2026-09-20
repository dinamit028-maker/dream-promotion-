export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export const uid = () => Math.random().toString(36).slice(2, 10);
export const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const today = () => iso(new Date());
export const addDays = (d: string, n: number) => {
  const x = new Date(d); x.setDate(x.getDate() + n); return iso(x);
};
export const HE_DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
export const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
export const fmtDay = (s: string) => { const d = new Date(s); return `${d.getDate()} ב${HE_MONTHS[d.getMonth()]}`; };
export const KIND_HE: Record<string, string> = { post: 'פוסט', reel: 'ריל', story: 'סטורי', ad: 'מודעה' };
export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'בוקר טוב' : h < 18 ? 'צהריים טובים' : 'ערב טוב';
};
