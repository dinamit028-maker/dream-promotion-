import { NO_DEPARTMENT, routeLead, type LeadFacts, type Routed, type RoutingDept } from './lead-routing';

/**
 * A request of the site (2.102, migration 20261017005400): "בקשת הצעת מחיר" of a product sold by a quote, or the contact form.
 * The storefront records it (sf_lead_request — a contact in the leads, and a row of site_requests); the dashboard's server routes
 * it (lib/server/site-leads.ts). Pure (no database, no network) — tested on its own (tests/site-leads.test.ts).
 */
export type SiteRequest = {
  id: string; business_id: string; kind: 'quote' | 'contact'; item_id: string | null; model: string; item_name: string;
  lead_id: string | null; new_contact: boolean; name: string; phone: string; email: string; qty: number | null; topic: string;
  notes: string; page: string; preview: boolean; created_at: string;
};

/** what the contact's routing says it came from ("טופס: …" on the card) */
export const siteFormName = (kind: SiteRequest['kind']) => (kind === 'quote' ? 'אתר — בקשת הצעת מחיר' : 'אתר — צור קשר');

/**
 * What a department's rule sees of a request — as the questions of a form: "מקור" = "אתר", "סוג הפנייה" = "הצעת מחיר" or "פנייה",
 * and when given "נושא" and "דגם". So a rule "שאלה ותשובה" (מקור → אתר, נושא → סורסינג…) recognises the site's requests too.
 */
export function siteFacts(r: Pick<SiteRequest, 'kind' | 'topic' | 'model'>): LeadFacts {
  return {
    formId: '', formName: siteFormName(r.kind), campaignId: '', campaignName: '',
    fields: [
      { key: 'source', label: 'מקור', values: ['אתר'] },
      { key: 'kind', label: 'סוג הפנייה', values: [r.kind === 'quote' ? 'הצעת מחיר' : 'פנייה'] },
      ...(r.topic ? [{ key: 'topic', label: 'נושא', values: [r.topic] }] : []),
      ...(r.model ? [{ key: 'model', label: 'דגם', values: [r.model] }] : []),
    ],
  };
}

/** {{4}} of the WhatsApp message: what was asked, a line each (the template's values join them into one line) */
export function siteDetails(r: Pick<SiteRequest, 'kind' | 'model' | 'item_name' | 'qty' | 'topic' | 'email' | 'notes' | 'preview'>): string {
  return [
    r.kind === 'quote' ? 'בקשת הצעת מחיר מהאתר' : 'פנייה מהאתר',
    r.model ? `דגם: ${r.model}${r.item_name ? ` — ${r.item_name}` : ''}` : '',
    r.qty ? `כמות: ${r.qty.toLocaleString('he-IL')}` : '',
    r.topic ? `נושא: ${r.topic}` : '',
    r.email ? `אימייל: ${r.email}` : '',
    r.notes ? `הערות: ${r.notes}` : '',
    r.preview ? 'בדיקה מהתצוגה המקדימה' : '',
  ].filter(Boolean).join('\n');
}

/**
 * The department and the person of a request: a department's rule that fits it first (the most specific, as for a Meta lead),
 * then the department the owner chose for the site's requests, then the default recipient (with "ללא מחלקה").
 */
export function routeSite(depts: RoutingDept[], r: Pick<SiteRequest, 'kind' | 'topic' | 'model'>, siteDept: RoutingDept | null, defaultStaffId: string | null): Routed {
  const byRule = routeLead(depts, siteFacts(r), null);
  if (byRule.departmentId) return byRule;
  if (siteDept) return { departmentId: siteDept.id, departmentName: siteDept.name, staffId: siteDept.staffId, by: 'פנייה מהאתר', viaDefault: false };
  return { departmentId: null, departmentName: NO_DEPARTMENT, staffId: defaultStaffId, by: '', viaDefault: Boolean(defaultStaffId) };
}
