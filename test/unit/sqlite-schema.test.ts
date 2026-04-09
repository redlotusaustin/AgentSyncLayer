import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database } from 'bun:sqlite';
import { createTestSqliteContext, initializeTestSqliteSchema } from '../helpers';

describe('Schema: FTS5 Table Alignment', () => {
  let ctx: ReturnType<typeof createTestSqliteContext>;

  beforeAll(async () => {
    ctx = createTestSqliteContext();
    await ctx.setup();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('S1.1: messages_fts virtual table structure', () => {
    test('messages_fts table exists', () => {
      const result = ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
        .get();
      expect(result).toBeDefined();
    });

    test('messages_fts has 6 columns', () => {
      const columns = ctx.db
        .prepare("PRAGMA table_info('messages_fts')")
        .all() as Array<{ name: string }>;
      expect(columns.length).toBe(6);
    });

    test('messages_fts has text column', () => {
      const columns = ctx.db
        .prepare("PRAGMA table_info('messages_fts')")
        .all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('text');
    });

    test('messages_fts has payload column', () => {
      const columns = ctx.db
        .prepare("PRAGMA table_info('messages_fts')")
        .all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('payload');
    });

    test('messages_fts does not use content sync (no content= or content_rowid=)', () => {
      const info = ctx.db
        .prepare("PRAGMA table_xinfo('messages_fts')")
        .all() as Array<{ name: string; hidden: number }>;
      // FTS5 content sync columns are hidden (hidden=1 or hidden=2)
      // Standalone FTS5 should have no hidden columns
      const hiddenColumns = info.filter(col => col.hidden > 0);
      expect(hiddenColumns.length).toBe(0);
    });
  });

  describe('S1.2: messages_ai trigger structure', () => {
    test('messages_ai trigger exists', () => {
      const result = ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='messages_ai'")
        .get();
      expect(result).toBeDefined();
    });

    test('messages_ai trigger body contains json_extract for text', () => {
      const result = ctx.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_ai'")
        .get() as { sql: string };
      expect(result.sql).toBeDefined();
      expect(result.sql).toContain("json_extract(new.payload, '$.text')");
    });

    test('messages_ai trigger is AFTER INSERT ON messages', () => {
      const result = ctx.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_ai'")
        .get() as { sql: string };
      expect(result.sql).toContain('AFTER INSERT ON messages');
    });
  });
});

describe('Schema: initializeTestSqliteSchema() alignment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-init-schema-test-'));
  let db: Database;

  beforeAll(() => {
    fs.mkdirSync(path.join(dir, '.agentsynclayer'), { recursive: true });
    const dbPath = path.join(dir, '.agentsynclayer', 'history.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('S2.1: initializeTestSqliteSchema creates aligned FTS5', () => {
    test('creates messages_fts with 6 columns', () => {
      // Call the schema initializer
      initializeTestSqliteSchema(db);

      const columns = db
        .prepare("PRAGMA table_info('messages_fts')")
        .all() as Array<{ name: string }>;
      expect(columns.length).toBe(6);
    });

    test('messages_fts has standalone text column (not content sync)', () => {
      const columns = db
        .prepare("PRAGMA table_info('messages_fts')")
        .all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('text');
    });

    test('creates messages_ai trigger with json_extract', () => {
      const result = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_ai'")
        .get() as { sql: string };
      expect(result.sql).toContain("json_extract(new.payload, '$.text')");
    });
  });
});
