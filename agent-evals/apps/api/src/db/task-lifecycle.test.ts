import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from './database.service.js';
import { SeedService } from './seed.service.js';
import { CatalogService } from '../catalog/catalog.service.js';

// Seeds a throwaway DB from a throwaway seed folder, without starting Nest.
const tmp = mkdtempSync(join(tmpdir(), 'evals-tasks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const configs = [
  { id: 'c', name: 'c', model: 'm', provider: 'p', toolsets: [], skills: [], maxTurns: 1, runBudgetSec: 10 },
];
const task = (id: string) => ({ id, name: id, prompt: 'p', scorer: { type: 'regex', pattern: '^x$' } });

function seed(dbPath: string, taskIds: string[], seedConfigs: object[] = configs) {
  writeFileSync(join(tmp, 'tasks.json'), JSON.stringify(taskIds.map(task)));
  writeFileSync(join(tmp, 'configs.json'), JSON.stringify(seedConfigs));
  process.env.DB_PATH = dbPath;
  process.env.SEED_DIR = tmp;
  const database = new DatabaseService();
  new SeedService(database).onModuleInit();
  return { database, catalog: new CatalogService(database) };
}

test('a task removed from tasks.json becomes inactive, not deleted; adding it back reactivates it', () => {
  const dbPath = join(tmp, 'lifecycle.db');
  let { database, catalog } = seed(dbPath, ['t1', 't2', 't3']);
  assert.deepEqual(catalog.listTasks().map((t) => t.id), ['t1', 't2', 't3']);
  database.onModuleDestroy();

  ({ database, catalog } = seed(dbPath, ['t1', 't3']));
  assert.deepEqual(catalog.listTasks().map((t) => t.id), ['t1', 't3']);
  assert.equal(catalog.getTask('t2')?.active, false, 'still readable for old results');
  database.onModuleDestroy();

  ({ database, catalog } = seed(dbPath, ['t1', 't2', 't3']));
  assert.equal(catalog.getTask('t2')?.active, true);
  database.onModuleDestroy();
});

test('a DB created before the "active" column existed gets it added, data kept', () => {
  const dbPath = join(tmp, 'old.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
    scorer_type TEXT NOT NULL, scorer_spec TEXT NOT NULL, reference_answer TEXT, files TEXT)`);
  old.prepare(`INSERT INTO tasks VALUES ('legacy', 'legacy', 'p', 'regex', '{}', NULL, NULL)`).run();
  old.close();

  const { database, catalog } = seed(dbPath, ['t1']);
  assert.equal(catalog.getTask('legacy')?.active, false, 'kept, and retired since it is not in tasks.json');
  assert.deepEqual(catalog.listTasks().map((t) => t.id), ['t1']);
  database.onModuleDestroy();
});

test('config memoryFiles round-trip through the DB; configs without them get an empty list', () => {
  const withMemory = { ...configs[0], id: 'm', memoryFiles: ['memory/sales-policy.md'] };
  const { database, catalog } = seed(join(tmp, 'memory.db'), ['t1'], [configs[0], withMemory]);
  assert.deepEqual(catalog.getConfig('m')?.memoryFiles, ['memory/sales-policy.md']);
  assert.deepEqual(catalog.getConfig('c')?.memoryFiles, []);
  database.onModuleDestroy();
});

test('a DB created before the "memory_files" column existed gets it added, configs kept', () => {
  const dbPath = join(tmp, 'old-configs.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE configs (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL,
    provider TEXT NOT NULL, toolsets TEXT NOT NULL, skills TEXT NOT NULL, max_turns INTEGER NOT NULL,
    run_budget_sec INTEGER NOT NULL, mock_pass_rate REAL)`);
  old.prepare(`INSERT INTO configs VALUES ('legacy', 'legacy', 'm', 'p', '[]', '[]', 1, 10, NULL)`).run();
  old.close();

  const { database, catalog } = seed(dbPath, ['t1']);
  assert.deepEqual(catalog.getConfig('legacy')?.memoryFiles, []);
  database.onModuleDestroy();
});

test('memory files outside memory/ are rejected at seed time', () => {
  for (const bad of ['notes/x.md', 'memory/../.env', '/etc/passwd']) {
    assert.throws(
      () => seed(join(tmp, 'bad.db'), ['t1'], [{ ...configs[0], memoryFiles: [bad] }]),
      /not a path under memory\//,
      bad,
    );
  }
});
