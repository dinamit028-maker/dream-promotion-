import { adminDb } from '@/lib/server/admin';
import { financeCaller } from '@/lib/server/finance';
import { requestDigest, taxGateway } from '@/lib/server/tax/gateway';
import { toDoc } from '@/features/documents/documents';
import { SEED_RULES, allocationNeed, isRealAllocation, minimizedRequest, toAllocationRow, toRule } from '@/features/finance/allocation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask for an allocation number for one tax invoice of the business worked in now.
 * Only a document of that business (from the server's own lookup, never the client's word), only one that needs a
 * number under the rule of its date, never twice. The request sent is minimized (identifiers and amounts — no names,
 * phones, addresses or lines); only its sha256 is stored. Every attempt and its answer are rows in tax_allocations
 * (append-only, logged by the database). A test gateway's number is stored as a test and never shown as real.
 */
export async function POST(req: Request) {
  const c = await financeCaller(req);
  if (!c.ok) return Response.json(c.body, { status: c.status });
  const body = await req.json().catch(() => ({}));
  const documentId = typeof body?.documentId === 'string' && /^[0-9a-f-]{36}$/i.test(body.documentId) ? body.documentId : null;
  if (!documentId) return Response.json({ code: 'bad_request', message: 'מסמך לא תקין.' }, { status: 400 });
  const db = adminDb();
  const { data: d } = await db.from('documents').select('*').eq('id', documentId).eq('business_id', c.businessId).maybeSingle();
  if (!d) return Response.json({ code: 'not_found', message: 'המסמך לא נמצא בעסק הזה.' }, { status: 404 });
  const doc = toDoc(d);
  if (![305, 320, 330].includes(doc.docType)) return Response.json({ code: 'not_tax_invoice', message: 'מספר הקצאה מבקשים לחשבונית מס בלבד.' }, { status: 400 });
  const [{ data: rows }, { data: ruleRows }] = await Promise.all([
    db.from('tax_allocations').select('*').eq('document_id', doc.id),
    db.from('tax_allocation_rules').select('*'),
  ]);
  if ((rows ?? []).map(toAllocationRow).some(isRealAllocation)) return Response.json({ code: 'exists', message: 'למסמך כבר יש מספר הקצאה.' }, { status: 409 });
  const rules = ruleRows?.length ? ruleRows.map(toRule) : SEED_RULES;
  const issuer = (d as any).issuer ?? {};
  const need = allocationNeed(doc, { entityType: issuer.entityType }, rules);
  if (!need.required) return Response.json({ code: 'not_required', message: `לא נדרש מספר הקצאה: ${need.reason}` }, { status: 400 });

  const gw = taxGateway();
  if (gw.mode === 'unconfigured') return Response.json({ code: 'not_configured', message: 'החיבור לרשות המסים לא הוגדר. אפשר להזין מספר שהתקבל מרשות המסים ידנית.' }, { status: 400 });
  const request = minimizedRequest(doc, { dealerNumber: issuer.dealerNumber });
  const digest = requestDigest(request);
  const gateway = gw.mode === 'mock' ? 'mock' : 'live';
  const isTest = gw.mode === 'mock';
  await db.from('tax_allocations').insert({ business_id: c.businessId, document_id: doc.id, user_id: c.userId, status: 'requested', is_test: isTest, gateway,
    rule_version: need.rule?.version ?? null, request_digest: digest });
  const r = await gw.requestAllocation(request, { businessId: c.businessId });
  const { error } = await db.from('tax_allocations').insert({
    business_id: c.businessId, document_id: doc.id, user_id: c.userId, status: r.status, is_test: r.isTest, gateway,
    allocation_number: r.status === 'approved' ? r.number ?? null : null, rule_version: need.rule?.version ?? null, request_digest: digest,
    error_code: (r.errorCode ?? '').slice(0, 60), error_message: (r.errorMessage ?? '').slice(0, 500),
  });
  if (error) return Response.json({ code: 'not_saved', message: 'התשובה לא נשמרה. נסו שוב.' }, { status: 500 });
  if (r.status !== 'approved') return Response.json({ code: r.errorCode ?? 'rejected', message: r.errorMessage ?? 'הבקשה לא אושרה.' }, { status: 502 });
  return Response.json({ status: 'approved', test: r.isTest, number: r.number,
    message: r.isTest ? `התקבל מספר בדיקה ${r.number} — סביבת בדיקות, לא מספר הקצאה של רשות המסים` : `התקבל מספר הקצאה ${r.number}` });
}
