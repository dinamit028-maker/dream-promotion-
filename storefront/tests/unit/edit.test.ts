/**
 * "לחץ לעריכה" (2.61): the visual editor frames a store page only with a valid edit token, and only from the dashboard's
 * origin; the token travels in a header the proxy sets (a request cannot bring its own); a shopper's page has no edit marks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { buildCsp } from '../../src/lib/csp';
import { dashboardOrigin, makePreviewToken } from '../../src/lib/preview';
import { editField, editLink, editSection } from '../../src/lib/edit';
import { proxy } from '../../src/proxy';

const SECRET = 'unit-preview-secret-0123456789abcdef';
const STORE = '11111111-2222-4333-8444-555555555555';
process.env.STOREFRONT_PREVIEW_SECRET = SECRET;
process.env.DASHBOARD_URL = 'https://dash.example.com/';
const token = () => makePreviewToken(STORE, SECRET, Date.now() / 1000 + 600);
const run = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`https://shop.example.com${path}`, { headers: { host: 'shop.example.com', 'x-forwarded-proto': 'https', ...headers } }));
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

test('the dashboard\'s origin: https (http only on localhost), never anything else', () => {
  assert.equal(dashboardOrigin('https://dash.example.com/x'), 'https://dash.example.com');
  assert.equal(dashboardOrigin('http://localhost:3219'), 'http://localhost:3219');
  assert.equal(dashboardOrigin('http://dash.example.com'), null);
  assert.equal(dashboardOrigin('javascript:alert(1)'), null);
  assert.equal(dashboardOrigin(undefined), null);
});

test('the CSP: framed by nobody — except the dashboard, when editing', () => {
  assert.match(buildCsp('n'), /frame-ancestors 'none'/);
  assert.match(buildCsp('n', { frameAncestor: 'https://dash.example.com' }), /frame-ancestors https:\/\/dash\.example\.com(;|$)/);
  assert.match(buildCsp('n', { frameAncestor: "https://x.com 'unsafe-inline'" }), /frame-ancestors 'none'/, 'only a plain origin');
});

test('the proxy: a valid edit token → framed by the dashboard, the token in the header, no cookie, no redirect, not cached', () => {
  const t = token();
  const res = run(`/?edit=${encodeURIComponent(t)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/dash\.example\.com/);
  assert.equal(forwarded(res, 'x-sf-edit'), t);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('the proxy: a forged or expired token, or one brought in a header, opens nothing', () => {
  for (const bad of ['x', makePreviewToken(STORE, 'another-secret-0123456789abcdef', Date.now() / 1000 + 600), makePreviewToken(STORE, SECRET, Date.now() / 1000 - 5)]) {
    const res = run(`/?edit=${encodeURIComponent(bad)}`);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(forwarded(res, 'x-sf-edit'), null);
  }
  const smuggled = run('/', { 'x-sf-edit': token() });
  assert.equal(forwarded(smuggled, 'x-sf-edit'), null, 'a request cannot bring its own edit header');
  delete process.env.DASHBOARD_URL;
  assert.match(run(`/?edit=${encodeURIComponent(token())}`).headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, 'no dashboard: no framing');
  process.env.DASHBOARD_URL = 'https://dash.example.com/';
});

test('the marks exist only when editing', () => {
  assert.deepEqual(editField(false, 'title'), {});
  assert.deepEqual(editField(true, 'title'), { 'data-edit-field': 'title', 'data-edit-inline': '' });
  assert.deepEqual(editField(true, 'text', false), { 'data-edit-field': 'text' });
  assert.deepEqual(editLink(true, 'menus:main'), { 'data-edit-link': 'menus:main' });
  assert.deepEqual(editSection(false, 'hero', 'hero'), {});
});
