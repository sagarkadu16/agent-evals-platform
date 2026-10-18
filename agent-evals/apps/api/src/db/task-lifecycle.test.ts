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

function seed(dbPath: string, taskIds: string[]) {
  writeFileSync(join(tmp, 'tasks.json'), JSON.stringify(taskIds.map(task)));
  writeFileSync(join(tmp, 'configs.json'), JSON.stringify(configs));
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
