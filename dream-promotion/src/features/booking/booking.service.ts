'use client';
import { supabase } from '@/lib/supabase/client';
import type { Hours } from './slots';
import type { ApptEvent, CalStaff } from './calendar';

/** Owner side of booking. Runs with the user's own session, so RLS keeps every business separate. */
export interface BookingSettings {
  slug: string | null; enabled: boolean; title: string; address: string; phone: string; message: string;
  slotMinutes: number; minNoticeMinutes: number; maxDaysAhead: number; hours: Hours; closedDates: string[];
}
export interface BookingServiceRow { id: string; name: string; minutes: number; price: number | null; active: boolean; sort: number;
  /** 2.88 (migration 4300): a deposit paid by link when the appointment is booked; offset from the final payment */
  deposit?: number | null }
export type ApptStatus = 'booked' | 'confirmed' | 'done' | 'no_show' | 'cancelled';
export interface Appointment {
  id: string; serviceId: string | null; serviceName: string; leadId: string | null; name: string; phone: string; email: string;
  note: string; start: string; end: string; status: ApptStatus; source: 'public' | 'manual';
  /** 2.91 (locations, migration 4600): where it is; none = the main location (a row from before it, or a business with one) */
  locationId?: string | null;
  /** 2.105 (migration 5700): the practitioner (a person of the team, lead_staff); none = waiting for one, or before the migration */
  staffId?: string | null;
}

export const DEFAULT_SETTINGS: BookingSettings = {
  slug: null, enabled: false, title: '', address: '', phone: '', message: '', slotMinutes: 30, minNoticeMinutes: 120, maxDaysAhead: 30,
  hours: { 0: [['09:00', '19:00']], 1: [['09:00', '19:00']], 2: [['09:00', '19:00']], 3: [['09:00', '19:00']], 4: [['09:00', '19:00']] } as any,
  closedDates: [],
};

const fromRow = (r: any): Appointment => ({
  id: r.id, serviceId: r.service_id, serviceName: r.service_name ?? '', leadId: r.lead_id, name: r.name, phone: r.phone ?? '', email: r.email ?? '',
  note: r.note ?? '', start: r.start_at, end: r.end_at, status: r.status, source: r.source, locationId: r.location_id ?? null,
  staffId: r.staff_id ?? null,
});

/** clear message for the errors a user can act on */
export const bookingError = (e: any): string => {
  const m = String(e?.message ?? e ?? '');
  // 2.105: one practitioner, one appointment at a time
  if (/appointments_staff_no_overlap/.test(m)) return 'כבר יש תור אצל המטפל/ת הזה/זו בשעה הזו. בחרו שעה אחרת או מטפל/ת אחר/ת.';
  if (/not an active practitioner/.test(m)) return 'המטפל/ת שנבחר/ה כבר לא ביומן. בחרו מטפל/ת אחר/ת.';
  if (e?.code === '23P01' || /no_overlap|exclusion/i.test(m)) return 'כבר יש תור בשעה הזו. בחרו שעה אחרת.';
  if (e?.code === '23505' || /duplicate key.*slug/i.test(m)) return 'הכתובת הזו כבר תפוסה. בחרו כתובת אחרת.';
  if (/slug_check|check constraint.*slug/i.test(m)) return 'כתובת הדף: אותיות באנגלית קטנות, ספרות ומקף, 3–40 תווים.';
  if (e?.code === '42501' || /not allowed/i.test(m)) return 'אין הרשאה לקבוע תור בסניף הזה.';
  if (/booking_services_deposit_check/.test(m)) return 'המקדמה: סכום גדול מאפס, ולא יותר ממחיר השירות.';
  if (/deposit/.test(m) && /column|schema cache/i.test(m)) return 'צריך להריץ את מיגרציה 20261010004300 (לינק לתשלום ומקדמה) ב-Supabase לפני שמגדירים מקדמה.';
  if (/relation .* does not exist|schema cache/i.test(m)) return 'צריך להריץ את מיגרציית זימון התורים ב-Supabase (20261003001000).';
  return 'משהו השתבש. נסו שוב.';
};

let calendarProbe: Promise<boolean> | null = null;

export const BookingAPI = {
  async settings(userId: string): Promise<BookingSettings> {
    const { data, error } = await supabase().from('booking_settings').select('*').maybeSingle();
    if (error) throw error;
    if (!data) return DEFAULT_SETTINGS;
    return {
      slug: data.slug, enabled: data.enabled, title: data.title, address: data.address, phone: data.phone, message: data.message,
      slotMinutes: data.slot_minutes, minNoticeMinutes: data.min_notice_minutes, maxDaysAhead: data.max_days_ahead,
      hours: data.hours ?? {}, closedDates: (data.closed_dates ?? []).map(String),
    };
  },
  async saveSettings(userId: string, s: BookingSettings) {
    const { error } = await supabase().from('booking_settings').upsert({
      user_id: userId, slug: s.slug || null, enabled: s.enabled, title: s.title, address: s.address, phone: s.phone, message: s.message,
      slot_minutes: s.slotMinutes, min_notice_minutes: s.minNoticeMinutes, max_days_ahead: s.maxDaysAhead, hours: s.hours, closed_dates: s.closedDates,
    }, { onConflict: 'business_id' }); // one row per business (business_id is filled by the database)
    if (error) throw error;
  },
  async services(userId: string): Promise<BookingServiceRow[]> {
    const { data, error } = await supabase().from('booking_services').select('*').order('sort').order('created_at');
    if (error) throw error;
    return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, minutes: r.minutes, price: r.price == null ? null : Number(r.price), active: r.active, sort: r.sort,
      // before migration 4300 there is no such column: left out, so saving a service never names it
      deposit: !('deposit' in r) ? undefined : r.deposit == null ? null : Number(r.deposit) }));
  },
  /** the service's id (a new one's, from the database) */
  async saveService(userId: string, s: Omit<BookingServiceRow, 'id'> & { id?: string }): Promise<string | undefined> {
    const row: Record<string, unknown> = { user_id: userId, name: s.name.trim(), minutes: s.minutes, price: s.price, active: s.active, sort: s.sort };
    // the deposit column comes with migration 4300: sent only when there is one to set or to clear
    if (s.deposit !== undefined) row.deposit = s.deposit;
    if (s.id) {
      const { error } = await supabase().from('booking_services').update(row).eq('id', s.id);
      if (error) throw error;
      return s.id;
    }
    const { data, error } = await supabase().from('booking_services').insert(row).select('id').single();
    if (error) throw error;
    return (data as { id?: string } | null)?.id;
  },
  async deleteService(id: string) {
    const { error } = await supabase().from('booking_services').delete().eq('id', id);
    if (error) throw error;
  },
  async appointments(userId: string, fromIso: string, toIso: string): Promise<Appointment[]> {
    const { data, error } = await supabase().from('appointments').select('*')
      .gte('start_at', fromIso).lt('start_at', toIso).order('start_at');
    if (error) throw error;
    return (data ?? []).map(fromRow);
  },
  /** 2.105: is migration 5700 there (a practitioner for an appointment, its history)? Asked once a session */
  async calendarReady(): Promise<boolean> {
    calendarProbe ??= (async () => {
      const { error } = await supabase().from('appointments').select('staff_id').limit(1);
      return !error;
    })();
    return calendarProbe;
  },
  /** 2.105: the team for the calendar — names, colours, who is a practitioner (appointment_staff(): never a number) */
  async staff(): Promise<CalStaff[]> {
    const { data, error } = await supabase().rpc('appointment_staff');
    if (error) return [];
    return ((data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name, color: r.color ?? '', practitioner: Boolean(r.practitioner),
      memberUserId: r.member_user_id ?? null, active: Boolean(r.active) }));
  },
  /** 2.105: another day, hour or practitioner — the same length; the database refuses a practitioner twice at once */
  async move(id: string, to: { start: string; end: string; staffId?: string | null }): Promise<Appointment> {
    const patch: Record<string, unknown> = { start_at: to.start, end_at: to.end };
    if (to.staffId !== undefined) patch.staff_id = to.staffId;
    const { data, error } = await supabase().from('appointments').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return fromRow(data);
  },
  /** 2.105: what happened to an appointment — written by the database only (appointment_events), oldest first */
  async history(id: string): Promise<ApptEvent[]> {
    const { data, error } = await supabase().from('appointment_events').select('id, at, actor_name, kind, before, after')
      .eq('appointment_id', id).order('at');
    if (error) return [];
    return ((data ?? []) as any[]).map((r) => ({ id: r.id, at: r.at, actorName: r.actor_name ?? '', kind: r.kind, before: r.before ?? {}, after: r.after ?? {} }));
  },
  async create(userId: string, a: Omit<Appointment, 'id' | 'source'>) {
    const { data, error } = await supabase().from('appointments').insert({
      user_id: userId, service_id: a.serviceId, service_name: a.serviceName, lead_id: a.leadId, name: a.name, phone: a.phone, email: a.email,
      note: a.note, start_at: a.start, end_at: a.end, status: a.status, source: 'manual',
      // a location chosen in the form (several locations, "כל הסניפים" picked); else the database puts it where the user works
      ...(a.locationId ? { location_id: a.locationId } : {}),
      // 2.105: the practitioner — sent only when there is one (before migration 5700 there is no such column)
      ...(a.staffId ? { staff_id: a.staffId } : {}),
    }).select('*').single();
    if (error) throw error;
    return fromRow(data);
  },
  async setStatus(id: string, status: ApptStatus) {
    const { error } = await supabase().from('appointments').update({ status }).eq('id', id);
    if (error) throw error;
  },
};
