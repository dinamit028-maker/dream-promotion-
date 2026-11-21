// Produces a sample unified-structure (ממשק פתוח, v1.31) export for the Tax Authority software-registration simulator.
//   npx -y tsx scripts/ita-sample.mjs [outDir]          (tsx, because it imports the app's own .ts/.tsx code as is)
//   env: ITA_DB (default ita_demo, a local postgres db with the migrations + tests/sql/ita-demo.seed.sql loaded, see that file),
//        ITA_BUSINESS (default the demo business), ITA_FROM / ITA_TO (default 2026-01-01 .. today (Israel))
// It does what "חבילת רואה החשבון" (src/features/finance/Accountant.tsx, pack()) does for the open format: documents of the period
// ordered by type and number, the cancellations set, toDoc -> buildOpenFormat(business, SOFTWARE, docs) -> INI.TXT +
// BKMVDATA.zip under OPENFRMT/<8 digits>.<YY>/<MMDDhhmm>/, and the two printouts from DocumentsTab (reportHtml / summaryHtml).
// Extra for the simulator: an unzipped BKMVDATA.TXT next to them. No code is copied: only the queries and the file layout.
// Without NEXT_PUBLIC_SOFTWARE_REG_NUMBER / NEXT_PUBLIC_SOFTWARE_VENDOR_VAT fields 1006 / 1009 are zeros (as in the product today).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { israelParts } from '../src/lib/il-time.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'docs/ita-registration/sample'));
const DB = process.env.ITA_DB ?? 'ita_demo';
const BIZ = process.env.ITA_BUSINESS ?? 'd3e00000-0000-4000-8000-000000000001';
const from = process.env.ITA_FROM ?? '2026-01-01';
const to = process.env.ITA_TO ?? israelParts(Date.now()).date;   // today (Israel), as the export screen's default (DocumentsTab)
if (!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('bad ITA_DB');
if (!/^[0-9a-f-]{36}$/.test(BIZ) || !/^\d{4}-\d\d-\d\d$/.test(from + '') || !/^\d{4}-\d\d-\d\d$/.test(to + '')) throw new Error('bad ITA_BUSINESS / ITA_FROM / ITA_TO');

// the app's version, as next.config.mjs puts it in NEXT_PUBLIC_APP_VERSION (before the app code reads it)
process.env.NEXT_PUBLIC_APP_VERSION ??= JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const { toDoc } = await import('../src/features/documents/documents.ts');
const { buildOpenFormat, docTypeReport, toIso88598 } = await import('../src/features/documents/openformat.ts');
const { SOFTWARE, reportHtml, summaryHtml } = await import('../src/features/documents/DocumentsTab.tsx');

const q = (sql) => {
  const r = spawnSync('su', ['postgres', '-c', `psql -X -At -v ON_ERROR_STOP=1 -d ${DB} -c "${sql.replace(/"/g, '\\"')}"`], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
// pack(): documents of the period (order type, number), document_cancellations, and the business settings (FinanceScreen: legal name, address)
const docRows = q(`select coalesce(json_agg(t), '[]') from (select * from documents where business_id='${BIZ}' and doc_date >= '${from}' and doc_date <= '${to}' order by doc_type, doc_number) t`);
const cancels = new Set(q(`select coalesce(json_agg(document_id), '[]') from document_cancellations where business_id='${BIZ}'`));
const rs = q(`select to_json(r) from register_settings r where business_id='${BIZ}'`);
const business = { dealerNumber: rs.dealer_number ?? '', companyNumber: rs.company_number ?? '', name: rs.legal_name || 'Dream Promotion', street: rs.street ?? '', houseNo: rs.house_no ?? '', city: rs.city ?? '', zip: rs.zip ?? '' };
if (!/^[0-9]{9}$/.test(business.dealerNumber)) throw new Error('business not ready (dealer number)');
const docs = docRows.map(toDoc).map((d) => ({ ...d, cancelled: cancels.has(d.id) }));

const startedAt = new Date().toISOString();
const f = buildOpenFormat(business, SOFTWARE, docs, { from, to, startedAt });
const dir = join(out, ...f.dir.split('\\'));
rmSync(join(out, 'OPENFRMT'), { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const bkmv = toIso88598(f.bkmv);
const inner = new JSZip(); inner.file('BKMVDATA.TXT', bkmv);
writeFileSync(join(dir, 'INI.TXT'), toIso88598(f.ini));
writeFileSync(join(dir, 'BKMVDATA.zip'), await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
writeFileSync(join(out, 'BKMVDATA.TXT'), bkmv);   // unzipped copy, for the simulator upload
writeFileSync(join(out, 'INI.TXT'), toIso88598(f.ini));
writeFileSync(join(out, 'דוח-מסמכים-לפי-סוג.html'), reportHtml(docTypeReport(docs, from, to), business, from, to));
writeFileSync(join(out, 'סיכום-הפקה-ממשק-פתוח.html'), summaryHtml({ ...f, startedAt }, business, from, to));
console.log(JSON.stringify({ out, dir: f.dir, counts: f.counts, totalRecords: f.totalRecords, bkmvBytes: bkmv.length, docs: docs.length, cancelled: docs.filter((d) => d.cancelled).length }, null, 1));
