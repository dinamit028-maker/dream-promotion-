export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export const uid = () => Math.random().toString(36).slice(2, 10);

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse YYYY-MM-DD as a LOCAL date. `new Date('2026-09-22')` is UTC midnight,
 *  which lands on the previous day anywhere west of UTC — never use it for days. */
export const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/** Format a Date as a LOCAL YYYY-MM-DD key. */
export const iso = (d: Date | string) => {
  const x = typeof d === 'string' ? parse(d) : d;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

export const today = () => iso(new Date());
export const addDays = (d: string, n: number) => {
  const x = parse(d); x.setDate(x.getDate() + n); return iso(x);
};
export const HE_DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
export const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
export const fmtDay = (s: string) => { const d = parse(s); return `${d.getDate()} ב${HE_MONTHS[d.getMonth()]}`; };
export const dayName = (s: string) => HE_DAYS[parse(s).getDay()];
export const KIND_HE: Record<string, string> = { post: 'פוסט', reel: 'ריל', story: 'סטורי', ad: 'מודעה' };
export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'בוקר טוב' : h < 18 ? 'צהריים טובים' : 'ערב טוב';
};

/** Brand-consistent colour pair per format, used when the model doesn't supply one. */
export const PALETTE: Record<string, [string, string]> = {
  post: ['#6B3BF5', '#A96BF8'],
  reel: ['#D6336C', '#FF8FA3'],
  story: ['#2F6FDB', '#5BC8D6'],
  ad: ['#3B2A8C', '#6B3BF5'],
};
