import { authHeaders } from '@/lib/services/http';
import { waLink } from '@/features/crm/crm';
import { form101Text, type AttachKind, type RequestStatus } from './form101';

/**
 * טופס 101 for the employer's screens — only through /api/attendance/form101 (the tables are read by the admin and payroll, and
 * written by the server alone; the files' bucket has no browser policy). Until migration 5900 is in the database every call says
 * so (`ready` = false) and nothing of it is shown.
 */
export interface FormRow {
  id: string; requestId: string; taxYear: number; version: number; formCode: string; signerName: string; submittedAt: string;
  paperAt: string | null; hasPaper: boolean; reviewedAt: string | null; reviewedBy: string; reviewNote: string; sha256: string;
  attachments: { kind: AttachKind; name: string; type: string; size: number }[]; missing: AttachKind[]; warnings: string[]; changeNote: string;
}
export interface LinkRow { id: string; taxYear: number; kind: 'year' | 'update'; status: RequestStatus; expiresAt: string; createdAt: string; openedAt: string | null; doneAt: string | null; sentBy: string }
export interface EmployeeForms { forms: FormRow[]; links: LinkRow[]; employerReady: boolean; thisYear: number }
export interface YearState { year: number; submitted: { employee_id: string; version: number; submitted_at: string; reviewed_at: string | null }[]; open: { employee_id: string; status: string }[] }

class NotReady extends Error {}
async function call<T>(method: 'GET' | 'POST', query: string, body?: unknown | FormData): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const r = await fetch(`/api/attendance/form101${query}`, {
    method, cache: 'no-store',
    headers: { ...(await authHeaders()), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 503 && j?.code === 'not_ready') throw new NotReady(j.message);
  if (!r.ok) throw new Error(j?.message || 'משהו השתבש. נסו שוב.');
  return j as T;
}
export const isNotReady = (e: unknown) => e instanceof NotReady;

export const loadEmployeeForms = (employeeId: string) => call<EmployeeForms>('GET', `?employeeId=${encodeURIComponent(employeeId)}`);
export const loadYear = (year: number) => call<YearState>('GET', `?year=${year}`);
export const fileUrl = (id: string, part: 'pdf' | 'paper' | 'attachment', n = 0) =>
  call<{ url: string }>('GET', `?file=${encodeURIComponent(id)}&part=${part}&n=${n}`).then((x) => x.url);
export const cancelLink = (requestId: string) => call('POST', '', { action: 'cancel', requestId });
export const reviewForm = (submissionId: string, note: string) => call('POST', '', { action: 'review', submissionId, note });
export function uploadPaper(submissionId: string, file: File) {
  const fd = new FormData();
  fd.append('action', 'paper'); fd.append('submissionId', submissionId); fd.append('file', file);
  return call('POST', '', fd);
}
export const saveEmployer = (deductionsFile: string, phone: string) =>
  call<{ employer: { name: string; address: string; phone: string; deductionsFile: string } }>('POST', '', { action: 'employer', deductionsFile, phone });
export const loadEmployer = () => call<{ employer: { name: string; address: string; phone: string; deductionsFile: string } }>('GET', '?employer=1');

/**
 * a new link for the employee, sent on WhatsApp. The window opens in the tap itself (a phone blocks a window opened after a
 * request) and goes to WhatsApp once the server made the link; without a phone the link is copied instead.
 */
export async function sendForm(e: { id: string; name: string; phone: string }, business: string, kind: 'year' | 'update', year?: number,
  opened?: Window | null): Promise<'whatsapp' | 'copied'> {
  // a window opened by the caller in the same tap (when other requests come first, as saving a new employee)
  const w = opened !== undefined ? opened : e.phone ? window.open('', '_blank') : null;
  try {
    const r = await call<{ path: string; year: number }>('POST', '', { action: 'send', employeeId: e.id, kind, year });
    const link = `${window.location.origin}${r.path}`;
    const text = form101Text(e.name, business, link, r.year, kind === 'update');
    const wa = e.phone ? waLink(e.phone, text) : '';
    if (w && wa) { w.location.href = wa; return 'whatsapp'; }
    w?.close();
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    return 'copied';
  } catch (err) { w?.close(); throw err; }
}
/** open a file of a form in a new tab (the window first, in the tap) */
export async function openFile(id: string, part: 'pdf' | 'paper' | 'attachment', n = 0) {
  const w = window.open('', '_blank');
  try { const u = await fileUrl(id, part, n); if (w) w.location.href = u; } catch (err) { w?.close(); throw err; }
}
