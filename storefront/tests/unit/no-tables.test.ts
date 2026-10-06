/**
 * The storefront never reads a table and never imports the dashboard (DREAM_COMMERCE_ARCHITECTURE §4.2, §7.1): a static
 * look at its source. Its only door is the sf_* functions of src/lib/data.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

test('no table is read: no .from( and no /rest/v1/<table>', () => {
  for (const f of files(SRC)) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\.from\(\s*['"`]/, `${path.relative(SRC, f)} reads a table`);
    assert.doesNotMatch(src, /\/rest\/v1\/(?!rpc\/)/, `${path.relative(SRC, f)} calls the REST API outside rpc`);
  }
});

test('only sf_* functions are called', () => {
  const data = readFileSync(path.join(SRC, 'lib/data.ts'), 'utf8');
  const called = [...data.matchAll(/'(sf_[a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(called.length >= 9);
  assert.ok(called.every((n) => n.startsWith('sf_')));
  for (const f of files(SRC)) {
    if (f.endsWith('lib/data.ts')) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\brpc\(|\/rest\/v1/, `${path.relative(SRC, f)} talks to the database itself`);
  }
});

test('nothing of the dashboard is imported, and Dream is never named to a shopper', () => {
  for (const f of files(SRC)) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from ['"](\.\.\/)+dream-promotion|from ['"]@\/features\//, `${path.relative(SRC, f)} imports the dashboard`);
    const shown = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');   // comments are not shown to anyone
    assert.doesNotMatch(shown, /Dream|דרים/, `${path.relative(SRC, f)} names the platform`);
  }
});

test('no inline style attribute anywhere (the CSP refuses them)', () => {
  for (const f of files(SRC).filter((x) => x.endsWith('.tsx'))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\sstyle=\{/, `${path.relative(SRC, f)} has an inline style`);
  }
});
