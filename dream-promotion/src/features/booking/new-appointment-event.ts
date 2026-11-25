/**
 * The big + of the phone's menu (AppShell): on the appointments screen it opens a new appointment (the screen listens to this event);
 * on every other screen it goes to /create, as before (2.117.3 — asked by a business, for all).
 */
export const NEW_APPOINTMENT_EVENT = 'dp:new-appointment';

/** what the + does on this path */
export const plusAction = (path: string | null | undefined): 'appointment' | 'create' =>
  path === '/appointments' || (path ?? '').startsWith('/appointments/') ? 'appointment' : 'create';
