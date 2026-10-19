import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemory, createRunHome, removeRunHome } from './hermes-home.js';

// Pure file-system tests: no Hermes process involved.
const tmp = mkdtempSync(join(tmpdir(), 'evals-home-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const assetsDir = join(tmp, 'assets');
const baseHome = join(tmp, 'base');
mkdirSync(join(baseHome, 'installs'), { recursive: true });
mkdirSync(join(assetsDir, 'memory'), { recursive: true });
writeFileSync(join(assetsDir, 'memory', 'policy.md'), 'Max discount 10%.\n');
writeFileSync(join(assetsDir, 'memory', 'links.md'), '\nBooking link: cal.example.com/sam-reed\n\n');
writeFileSync(join(assetsDir, 'outside.md'), 'not memory');

test('memory files become Hermes MEMORY.md entries, trimmed and joined by "§" lines', () => {
  assert.equal(
    buildMemory(assetsDir, ['memory/policy.md', 'memory/links.md']),
    'Max discount 10%.\n§\nBooking link: cal.example.com/sam-reed',
  );
  assert.equal(buildMemory(assetsDir, []), '');
});

test('memory files must exist, live under memory/, and fit Hermes’ 2,200-char limit', () => {
  assert.throws(() => buildMemory(assetsDir, ['memory/missing.md']), /not found/);
  assert.throws(() => buildMemory(assetsDir, ['outside.md']), /not under memory\//);
  assert.throws(() => buildMemory(assetsDir, ['memory/../outside.md']), /unsafe file path/);
  writeFileSync(join(assetsDir, 'memory', 'huge.md'), 'x'.repeat(2201));
  assert.throws(() => buildMemory(assetsDir, ['memory/huge.md']), /2201 chars; Hermes allows 2200/);
});

test('a run home gets MEMORY.md only when the config has memory files', () => {
  const withMemory = createRunHome({ baseHome, assetsDir, skills: [], memoryFiles: ['memory/policy.md'] });
  const without = createRunHome({ baseHome, assetsDir, skills: [] });
  try {
    assert.equal(readFileSync(join(withMemory, 'memories', 'MEMORY.md'), 'utf8'), 'Max discount 10%.');
    assert.deepEqual(readdirSync(join(without, 'memories')), []);
  } finally {
    removeRunHome(withMemory);
    removeRunHome(without);
  }
});

test('a bad memory file creates no home at all', () => {
  const before = readdirSync(tmpdir()).filter((d) => d.startsWith('evals-hermes-home-')).length;
  assert.throws(() => createRunHome({ baseHome, assetsDir, skills: [], memoryFiles: ['memory/missing.md'] }));
  const afterCount = readdirSync(tmpdir()).filter((d) => d.startsWith('evals-hermes-home-')).length;
  assert.equal(afterCount, before);
});

test('removing a run home keeps the shared installs', () => {
  const home = createRunHome({ baseHome, assetsDir, skills: [] });
  removeRunHome(home);
  assert.equal(existsSync(home), false);
  assert.ok(existsSync(join(baseHome, 'installs')));
});
