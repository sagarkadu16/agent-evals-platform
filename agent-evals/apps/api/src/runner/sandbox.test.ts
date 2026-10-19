import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Step } from '@evals/shared';
import { describeViolations, findSandboxViolations } from './sandbox.js';

const tmp = mkdtempSync(join(tmpdir(), 'evals-sandbox-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const workDir = join(tmp, 'run-1');
mkdirSync(workDir);

const call = (toolName: string, args: unknown): Step => ({
  index: 0,
  kind: 'tool',
  toolName,
  content: JSON.stringify(args),
});
const check = (...steps: Step[]) => findSandboxViolations(steps, workDir);

test('paths inside the run folder are fine: relative, ./, nested, absolute and macOS /private aliases', () => {
  assert.deepEqual(
    check(
      call('read_file', { path: 'orders.csv' }),
      call('read_file', { path: './data/x.csv' }),
      call('write_file', { path: join(workDir, 'out.txt') }),
      call('search_files', { pattern: '*', path: realpathSync(workDir) }),
      call('search_files', { pattern: 'orders.csv', target: 'files' }),
      call('patch', { path: '/dev/null' }),
    ),
    [],
  );
});

test('reading the repo, a parent folder, a sibling run or the home folder is a violation', () => {
  const found = check(
    call('search_files', { pattern: 'sales policy', path: '/Users/someone/project' }),
    call('read_file', { path: '../run-2/session-export/x.jsonl' }),
    call('read_file', { path: '~/.hermes/memories/MEMORY.md' }),
    call('read_file', { file_path: join(homedir(), 'notes.md') }),
  );
  assert.deepEqual(
    found.map((v) => v.tool),
    ['search_files', 'read_file', 'read_file', 'read_file'],
  );
  assert.equal(found[1].path, '../run-2/session-export/x.jsonl');
});

test('a folder whose name starts like the run folder is still outside it', () => {
  assert.equal(check(call('read_file', { path: `${workDir}-other/secret.txt` })).length, 1);
});

test('model steps, non-JSON arguments and non-path arguments are ignored', () => {
  assert.deepEqual(
    check(
      { index: 0, kind: 'model', content: 'I read /etc/hosts earlier' },
      { index: 1, kind: 'tool', toolName: 'read_file', content: 'not json' },
      call('search_files', { pattern: '/etc/hosts', target: 'content' }),
    ),
    [],
  );
});

test('the error message names the tool and path, and caps the list', () => {
  const v = Array.from({ length: 5 }, (_, i) => ({ tool: 'read_file', path: `/x/${i}` }));
  assert.equal(
    describeViolations(v),
    'sandbox violation: the agent accessed files outside its run folder: read_file /x/0; read_file /x/1; read_file /x/2 (+2 more)',
  );
});
