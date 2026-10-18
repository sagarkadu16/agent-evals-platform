import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA } from './schema.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: DatabaseSync;

  constructor() {
    const file = resolve(process.env.DB_PATH ?? 'data/evals.db');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.addMissingColumns();
  }

  /**
   * CREATE TABLE IF NOT EXISTS never changes an existing table. Columns added after a DB was created
   * are added here, so an existing DB (and its experiment results) can be kept.
   */
  private addMissingColumns() {
    const added: [table: string, column: string, definition: string][] = [
      ['tasks', 'active', 'INTEGER NOT NULL DEFAULT 1'],
    ];
    for (const [table, column, definition] of added) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  onModuleDestroy() {
    this.db.close();
  }
}
