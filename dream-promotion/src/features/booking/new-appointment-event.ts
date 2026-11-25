/**
 * The big + of the phone's bottom menu (AppShell), 2.117.3 — asked by a business, for all:
 *   - on the appointments screen it opens a new appointment (the screen listens to NEW_APPOINTMENT_EVENT);
 *   - a calendar member ("יומן בלבד" / "יומן ולידים") elsewhere (the clients' screen): to the appointments screen, opening a new one
 *     (NEW_APPOINTMENT_HREF — the screen reads ?new=1 once, after its first load);
 *   - everyone else elsewhere: /create, as before.
 */
export const NEW_APPOINTMENT_EVENT = 'dp:new-appointment';
export const NEW_APPOINTMENT_HREF = '/appointments?new=1';

const onAppointments = (path: string | null | undefined) => path === '/appointments' || (path ?? '').startsWith('/appointments/');

/** what the + does on this path */
export const plusAction = (path: string | null | undefined, calendarMember = false): 'appointment' | 'appointment-link' | 'create' =>
  onAppointments(path) ? 'appointment' : calendarMember ? 'appointment-link' : 'create';
