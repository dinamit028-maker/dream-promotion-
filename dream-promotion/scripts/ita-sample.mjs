// Produces a sample unified-structure (ממשק פתוח, v1.31) export for the Tax Authority software-registration simulator.
//   npx -y tsx scripts/ita-sample.mjs [outDir]          (tsx, because it imports the app's own .ts/.tsx code as is)
//   env: ITA_DB (default ita_demo, a local postgres db with the migrations + tests/sql/ita-demo.seed.sql loaded, see that file),
//        ITA_BUSINESS (default the demo business), ITA_FROM / ITA_TO (default 2026-01-01 .. today (Israel))
// It does what "חבילת רואה החשבון" (src/features/finance/Accountant.tsx, pack()) does for the open format: documents of the period
// ordered by type and number, the cancellations set, the people's codes (member_doc_codes, if there), toDoc -> buildOpenFormat(business,
// SOFTWARE, docs, { codes }) -> INI.TXT +
// BKMVDATA.zip under OPENFRMT/<8 digits>.<YY>/<MMDDhhmm>/, and the two printouts from DocumentsTab (reportHtml / summaryHtml).
// Extra for the simulator: an unzipped BKMVDATA.TXT next to them. No code is copied: only the queries and the file layout.
// Without NEXT_PUBLIC_SOFTWARE_REG_NUMBER / NEXT_PUBLIC_SOFTWARE_VENDOR_VAT fields 1006 / 1009 are zeros, and without
// NEXT_PUBLIC_SOFTWARE_VENDOR_NAME field 1010 is "Dream Promotion" (as in the product when they are not set).
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
const { BOOKS_FILE_BROKEN, BOOKS_PERIOD_SPLIT, buildOpenFormat, booksFileProblems, booksPeriod, docCodesMap, docTypeReport, toIso88598 } = await import('../src/features/documents/openformat.ts');
const { booksFileOf } = await import('../src/features/documents/openformat-books.ts');
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
const business = { dealerNumber: rs.dealer_number ?? '', companyNumber: rs.company_number ?? '', deductionsFile: rs.deductions_file ?? null, name: rs.legal_name || 'Dream Promotion', street: rs.street ?? '', houseNo: rs.house_no ?? '', city: rs.city ?? '', zip: rs.zip ?? '' };
if (!/^[0-9]{9}$/.test(business.dealerNumber)) throw new Error('business not ready (dealer number)');
const docs = docRows.map(toDoc).map((d) => ({ ...d, cancelled: cancels.has(d.id) }));
// field 1233 (2.117): the people's codes, as pack() reads them (loadDocCodes) — only when migration 20261122006700 is in this database;
// without it, none (1233 as before)
const hasCodes = q(`select to_json(to_regclass('public.member_doc_codes') is not null)`);
const codes = docCodesMap(hasCodes ? q(`select coalesce(json_agg(json_build_object('user_id', user_id, 'code', code)), '[]') from member_doc_codes where business_id='${BIZ}'`) : []);

// 2.120 (migration 20261127007000): a business that numbers per location — 1034 = 1 and each document's branch code, as pack()
// does (loadBranchInfo); a database before 7000 / a business that did not switch — none (the file as before)
const switched = q(`select to_json(to_regclass('public.document_numbering') is not null and exists (select 1 from document_numbering where business_id='${BIZ}'))`);
let branches = null;
if (switched) {
  const locs = q(`select coalesce(json_agg(json_build_object('id', id, 'code', branch_code)), '[]') from business_locations where business_id='${BIZ}' and branch_code is not null`);
  const baseRows = q(`select coalesce(json_agg(json_build_object('k', doc_type || ':' || doc_number, 'loc', location_id)), '[]') from documents where business_id='${BIZ}'`);
  branches = { perLocation: true, businessId: BIZ, codes: new Map(locs.map((l) => [l.id, l.code])), baseLocations: new Map(baseRows.map((r) => [r.k, r.loc])) };
}
// 2.124 (stage 4ה): the books — as pack() does (loadBooksStart, loadBooksForFile): a period from the books' start on is written from
// them (B100 + B110, 1013 = 2) — the same database answers the screens read, as the business's owner signed in (report_journal /
// report_trial_balance are security invoker: the RLS of the business); a period across the start is refused; before it / a
// database before 7100 — as before. scripts/ita-sample-books.sql gives the licensed demo books from 1.6.2026.
const hasBooks = q(`select to_json(to_regclass('public.gl_books') is not null)`);
const booksStart = hasBooks ? q(`select coalesce(json_agg(start_date), '[]') from gl_books where business_id='${BIZ}'`)[0] ?? null : null;
const kind = booksPeriod(from, to, booksStart);
if (kind === 'straddle') throw new Error(BOOKS_PERIOD_SPLIT(booksStart));
let books = null;
if (kind === 'books') {
  const owner = q(`select to_json(user_id) from business_members where business_id='${BIZ}' and role='owner' order by user_id limit 1`);
  if (!/^[0-9a-f-]{36}$/.test(owner ?? '')) throw new Error('no owner');
  // as the owner (the RLS of the business — the reports refuse anyone else); psql prints SET for each set, then the answer
  const asOwner = (sql) => {
    const r = spawnSync('su', ['postgres', '-c', `psql -X -At -v ON_ERROR_STOP=1 -d ${DB} -c "set role authenticated; set request.jwt.claim.sub = '${owner}'; set request.jwt.claim.role = 'authenticated'; ${sql.replace(/"/g, '\\"')}"`], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout.split('\n').filter((l) => l && l !== 'SET').join('\n'));
  };
  const unposted = asOwner(`select to_json(count(*)) from gl_unposted where source_date between '${from}' and '${to}'`);
  if (unposted) throw new Error(`${unposted} sources of the period did not post — gl_replay first`);
  const r = booksFileOf({ start: booksStart,
    journal: asOwner(`select report_journal('${from}', '${to}')`), trialBalance: asOwner(`select report_trial_balance('${from}', '${to}')`),
    accounts: asOwner(`select coalesce(json_agg(json_build_object('key', key, 'name', name, 'tb_code', tb_code, 'tb_name', tb_name, 'parent_key', parent_key, 'role', role, 'dealer_number', dealer_number, 'street', street, 'city', city, 'location_id', location_id) order by key), '[]') from gl_accounts`),
    users: asOwner(`select coalesce(json_agg(json_build_object('id', id, 'user_id', user_id) order by number), '[]') from gl_transactions where tx_date between '${from}' and '${to}'`) });
  if (!r.ok || booksFileProblems(r.books).length) throw new Error(BOOKS_FILE_BROKEN + (r.ok ? ' ' + booksFileProblems(r.books).join(',') : ' ' + r.problem));
  books = r.books;
}
const startedAt = new Date().toISOString();
const f = buildOpenFormat(business, SOFTWARE, docs, { from, to, startedAt, codes, branches, booksStart, books });
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
console.log(JSON.stringify({ out, dir: f.dir, counts: f.counts, totalRecords: f.totalRecords, bkmvBytes: bkmv.length, docs: docs.length, cancelled: docs.filter((d) => d.cancelled).length, codes: hasCodes ? codes.size : 'no member_doc_codes table', books: kind, booksStart }, null, 1));
