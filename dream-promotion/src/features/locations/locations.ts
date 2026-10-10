/**
 * Locations and registers (docs/FINANCE_ADDITIONS_HE.md T12א; migration 20261010004600) — the rules the screens follow, in one place.
 *   a location   the business's stores, branches, warehouses and clinics. The MAIN one has the business's own id: a row with no
 *                location (from before 2.91) is the main location's. A business with one active location sees none of this.
 *   a register   a cash register of a location (its name, the device it stands on). The main location's first register has the
 *                business's id too: a sale or a day of the register with no register is its.
 *   the switch   "כל הסניפים" or one location — the database shows only that location's rows (like the business switch).
 * Pure functions: the database decides (location_state(), the *_location_gate policies); the screens only ask what to show.
 */
export type LocationKind = 'store' | 'branch' | 'warehouse' | 'clinic';
export const KIND_HE: Record<LocationKind, string> = { store: 'חנות', branch: 'סניף', warehouse: 'מחסן', clinic: 'קליניקה' };
export const KINDS: LocationKind[] = ['store', 'branch', 'clinic', 'warehouse'];
export const MAX_LOCATIONS = 10;
export const MAX_REGISTERS = 10;

export interface Location { id: string; name: string; kind: LocationKind; address: string; phone: string; hours: string; active: boolean; sort: number; main: boolean }
export interface Register { id: string; locationId: string; name: string; device: string; active: boolean; sort: number; main: boolean }
export interface LocationState {
  /** migration 4600 is in the database */
  ready: boolean;
  businessId: string | null;
  /** the location picked at the top (null = all the caller may use) */
  current: string | null;
  /** a member limited to some locations (by the super admin) */
  limited: boolean;
  /** may shape the locations and registers (the business's owner, or the super admin) */
  owner: boolean;
  /** the locations the caller may use — active and closed; the main one first */
  locations: Location[];
  registers: Register[];
}
export const NO_LOCATIONS: LocationState = { ready: false, businessId: null, current: null, limited: false, owner: false, locations: [], registers: [] };

const kindOf = (k: unknown): LocationKind => (KINDS.includes(k as LocationKind) ? (k as LocationKind) : 'branch');
export const toLocation = (r: any): Location => ({
  id: String(r.id), name: String(r.name ?? ''), kind: kindOf(r.kind), address: String(r.address ?? ''), phone: String(r.phone ?? ''),
  hours: String(r.hours ?? ''), active: r.active !== false, sort: Number(r.sort ?? 0), main: Boolean(r.main),
});
export const toRegister = (r: any): Register => ({
  id: String(r.id), locationId: String(r.location ?? r.location_id ?? ''), name: String(r.name ?? ''), device: String(r.device ?? ''),
  active: r.active !== false, sort: Number(r.sort ?? 0), main: Boolean(r.main),
});
/** location_state()'s answer → the screens' state (anything else: as before locations) */
export function toLocationState(j: any): LocationState {
  if (!j || typeof j !== 'object' || !Array.isArray(j.locations)) return NO_LOCATIONS;
  return {
    ready: true, businessId: j.business ? String(j.business) : null, current: j.current ? String(j.current) : null,
    limited: Boolean(j.limited), owner: Boolean(j.owner),
    locations: j.locations.map(toLocation), registers: Array.isArray(j.registers) ? j.registers.map(toRegister) : [],
  };
}

export const activeLocations = (s: LocationState) => s.locations.filter((l) => l.active);
/** the business works with locations: more than one active location among those the caller may use */
export const multiLocation = (s: LocationState) => activeLocations(s).length > 1;
/** the switch at the top: only with a choice to make */
export const showSwitch = multiLocation;
export const locationName = (s: LocationState, id: string | null | undefined) => s.locations.find((l) => l.id === id)?.name ?? '';
/** a row's location: none (a row from before 2.91) is the main location's — the business's own id */
export const locationOf = (row: { location_id?: string | null; locationId?: string | null }, businessId: string) =>
  row.location_id ?? row.locationId ?? businessId;
/** a row's register: none is the main register's — the business's own id */
export const registerOf = (row: { register_id?: string | null; registerId?: string | null }, businessId: string) =>
  row.register_id ?? row.registerId ?? businessId;

/** the switch's choices: all (when there is more than one), then every active location — and the one picked, even when closed */
export function switchOptions(s: LocationState): { value: string; label: string }[] {
  const list = s.locations.filter((l) => l.active || l.id === s.current);
  return [...(list.length > 1 ? [{ value: '', label: 'כל הסניפים' }] : []), ...list.map((l) => ({ value: l.id, label: l.active ? l.name : `${l.name} (סגור)` }))];
}
export const switchLabel = (s: LocationState) => (s.current ? locationName(s, s.current) : 'כל הסניפים');

/** where a new row goes when the screen asks: the location picked, else the caller's only one / the main one / the first active */
export function defaultLocation(s: LocationState): string | null {
  if (s.current) return s.current;
  const active = activeLocations(s);
  return active.find((l) => l.main)?.id ?? active[0]?.id ?? null;
}
/** a form's location field: shown only when there is a choice — several locations and "all" picked */
export const locationChoices = (s: LocationState) => (multiLocation(s) && !s.current ? activeLocations(s) : []);

/** the registers one may sell at now: active, in an active location — the one picked, or every one */
export function registersHere(s: LocationState): Register[] {
  const open = new Set(activeLocations(s).map((l) => l.id));
  const place = new Map(s.locations.map((l, i) => [l.id, i]));      // grouped by location, in the locations' order
  return s.registers.filter((r) => r.active && open.has(r.locationId) && (!s.current || r.locationId === s.current))
    .sort((a, b) => (place.get(a.locationId) ?? 0) - (place.get(b.locationId) ?? 0));
}
/** the register picker: only when there is more than one register here */
export const showRegisterPicker = (s: LocationState) => registersHere(s).length > 1;
/** this device's register: the one it remembers, while it is still here; else the main one; else the first */
export function pickRegister(s: LocationState, remembered: string | null): string | null {
  const here = registersHere(s);
  if (remembered && here.some((r) => r.id === remembered)) return remembered;
  return here.find((r) => r.main)?.id ?? here[0]?.id ?? null;
}
/** a register's name for a person: "קופה 2", and its location's when the business has several */
export function registerLabel(s: LocationState, id: string | null): string {
  const r = s.registers.find((x) => x.id === id);
  if (!r) return '';
  return multiLocation(s) ? `${r.name} · ${locationName(s, r.locationId)}` : r.name;
}
/** a list's row, where it was: its location — only with several locations and "כל הסניפים" picked (else it says nothing new) */
export const locationTag = (s: LocationState, row: { location_id?: string | null; locationId?: string | null }, businessId: string) =>
  multiLocation(s) && !s.current ? locationName(s, locationOf(row, businessId)) : '';
/** a sale's row: its register (and location) when the business has more than one register, else its location as above */
export function saleTag(s: LocationState, row: { register_id?: string | null; registerId?: string | null; location_id?: string | null; locationId?: string | null }, businessId: string) {
  if (s.registers.length > 1) return registerLabel(s, registerOf(row, businessId));
  return locationTag(s, row, businessId);
}
/** the rows of one location (none = the main one's); with no location given — all of them (one location: as before) */
export const atLocation = <T extends { location_id?: string | null; locationId?: string | null }>(rows: T[], locationId: string | null | undefined, businessId: string) =>
  (locationId ? rows.filter((r) => locationOf(r, businessId) === locationId) : rows);
/** what is on this register: rows whose register (none = the main one) is it */
export const onRegister = <T extends { register_id?: string | null; registerId?: string | null }>(rows: T[], registerId: string, businessId: string) =>
  rows.filter((r) => registerOf(r, businessId) === registerId);

// ---- the owner's screen ----------------------------------------------------------------------------------------------------
export interface LocationInput { id?: string | null; name: string; kind: LocationKind; address: string; phone: string; hours: string; active: boolean; sort: number }
export interface RegisterInput { id?: string | null; locationId: string; name: string; device: string; active: boolean; sort: number }

export function locationError(i: LocationInput, others: Location[]): string | null {
  const name = i.name.trim();
  if (!name) return 'צריך שם לסניף.';
  if (name.length > 60) return 'שם הסניף ארוך מדי (עד 60 תווים).';
  if (others.some((l) => l.id !== i.id && l.name.trim().toLowerCase() === name.toLowerCase())) return 'כבר יש סניף בשם הזה.';
  if (!KINDS.includes(i.kind)) return 'סוג הסניף לא מוכר.';
  if (i.address.trim().length > 200) return 'הכתובת ארוכה מדי.';
  if (!/^[0-9+\- ]{0,20}$/.test(i.phone.trim())) return 'מספר הטלפון לא תקין.';
  if (i.hours.length > 300) return 'שעות הפתיחה ארוכות מדי.';
  if (!i.id && others.length >= MAX_LOCATIONS) return `אפשר עד ${MAX_LOCATIONS} סניפים לעסק.`;
  return null;
}
export function registerError(i: RegisterInput, others: Register[]): string | null {
  const name = i.name.trim();
  if (!name) return 'צריך שם לקופה.';
  if (name.length > 40) return 'שם הקופה ארוך מדי (עד 40 תווים).';
  if (others.some((r) => r.id !== i.id && r.locationId === i.locationId && r.name.trim().toLowerCase() === name.toLowerCase())) return 'כבר יש קופה בשם הזה בסניף.';
  if (i.device.trim().length > 80) return 'תיאור המכשיר ארוך מדי.';
  if (!i.id && others.filter((r) => r.locationId === i.locationId).length >= MAX_REGISTERS) return `אפשר עד ${MAX_REGISTERS} קופות בסניף.`;
  return null;
}
/** the next free "קופה N" of a location */
export function nextRegisterName(regs: Register[], locationId: string) {
  const used = new Set(regs.filter((r) => r.locationId === locationId).map((r) => r.name.trim()));
  for (let n = 1; ; n++) if (!used.has(`קופה ${n}`)) return `קופה ${n}`;
}

export const LOCATIONS_MIGRATION = 'סניפים וקופות עוד לא הופעלו במסד הנתונים (מיגרציה 20261010004600).';
/** a database refusal → what to tell the owner */
export function locationErrorHe(e: unknown): string {
  const m = `${(e as any)?.message ?? e ?? ''} ${(e as any)?.code ?? ''} ${(e as any)?.details ?? ''}`;
  if (/location_state|location_save|register_save|location_select|PGRST202|42883|schema cache|does not exist/i.test(m) && !/register_shifts/.test(m)) return LOCATIONS_MIGRATION;
  if (/locations_limit/.test(m)) return `אפשר עד ${MAX_LOCATIONS} סניפים לעסק.`;
  if (/registers_limit/.test(m)) return `אפשר עד ${MAX_REGISTERS} קופות בסניף.`;
  if (/business_locations_name_uq/.test(m)) return 'כבר יש סניף בשם הזה.';
  if (/registers_name_uq/.test(m)) return 'כבר יש קופה בשם הזה בסניף.';
  if (/locations_last/.test(m)) return 'צריך להשאיר לפחות סניף פעיל אחד.';
  if (/location_open_shift/.test(m)) return 'יש יום פתוח בקופה של הסניף — סוגרים אותו קודם.';
  if (/register_open_shift/.test(m)) return 'יש יום פתוח בקופה הזו — סוגרים אותו קודם.';
  if (/register_location/.test(m)) return 'הסניף סגור — אי אפשר להוסיף או לפתוח בו קופה.';
  if (/register_inactive/.test(m)) return 'הקופה הזו סגורה. בוחרים קופה אחרת.';
  if (/business_locked/.test(m)) return 'העסק נעול כרגע.';
  if (/42501|not allowed|row-level security|permission denied/i.test(m)) return 'אין הרשאה לפעולה הזו.';
  return 'משהו השתבש. נסו שוב.';
}
