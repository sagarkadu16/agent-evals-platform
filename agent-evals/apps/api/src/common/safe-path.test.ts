import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeRelativePath, resolveInside } from './safe-path.js';

test('plain relative paths are safe', () => {
  for (const p of ['orders.csv', 'data/orders.csv', 'a/b/c.txt']) assert.ok(isSafeRelativePath(p), p);
});

test('absolute, parent-escaping, backslash and empty paths are rejected', () => {
  for (const p of ['', '/etc/passwd', '../x', 'a/../../x', 'a\\b', '..']) assert.equal(isSafeRelativePath(p), false, p);
});

test('resolveInside keeps files in the root', () => {
  assert.equal(resolveInside('/tmp/run', 'data/x.csv'), '/tmp/run/data/x.csv');
  assert.throws(() => resolveInside('/tmp/run', '../escape.txt'));
});
