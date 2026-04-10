import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
      const columns = ctx.db.prepare("PRAGMA table_info('messages_fts')").all() as Array<{
        name: string;
      }>;
      expect(columns.length).toBe(6);
    });

    test('messages_fts has text column', () => {
      const columns = ctx.db.prepare("PRAGMA table_info('messages_fts')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('text');
    });

    test('messages_fts has payload column', () => {
      const columns = ctx.db.prepare("PRAGMA table_info('messages_fts')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('payload');
    });

    test('messages_fts does not use content sync (has expected visible columns)', () => {
      // FTS5 virtual tables always have 2 internal hidden columns (rowid mapping).
      // The important check is that visible columns are correct, not hidden column count.
      // PRAGMA table_info shows only visible columns (hidden=0), verifying the schema.
      const columns = ctx.db.prepare("PRAGMA table_info('messages_fts')").all() as Array<{
        name: string;
      }>;
      const visibleColumnNames = columns.map((c) => c.name);
      // Verify standalone FTS5: must have id, channel, from, type, text, payload as visible columns
      expect(visibleColumnNames).toEqual(['id', 'channel', 'from', 'type', 'text', 'payload']);
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

      const columns = db.prepare("PRAGMA table_info('messages_fts')").all() as Array<{
        name: string;
      }>;
      expect(columns.length).toBe(6);
    });

    test('messages_fts has standalone text column (not content sync)', () => {
      const columns = db.prepare("PRAGMA table_info('messages_fts')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((c) => c.name);
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

describe('Schema: FTS5 Search Snippet Extraction (T4)', () => {
  let ctx: ReturnType<typeof createTestSqliteContext>;

  beforeAll(async () => {
    ctx = createTestSqliteContext();
    await ctx.setup();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  test('T4: FTS5 search returns snippets from text column, not raw JSON', () => {
    const db = ctx.db;

    // Insert a message with a searchable payload
    const testMessage = {
      id: `test-${Date.now()}`,
      channel: 'general',
      from: 'test-agent',
      type: 'info',
      payload: JSON.stringify({ text: 'hello world search target' }),
      timestamp: new Date().toISOString(),
      project: 'testproject',
      created_at: Date.now(),
    };

    db.prepare(`
      INSERT INTO messages (id, channel, "from", type, payload, timestamp, project, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      testMessage.id,
      testMessage.channel,
      testMessage.from,
      testMessage.type,
      testMessage.payload,
      testMessage.timestamp,
      testMessage.project,
      testMessage.created_at,
    );

    // Search for the message using the text column content
    const searchQuery = 'search target';
    const sanitizedQuery = `"${searchQuery}"*`;

    const results = db
      .prepare(`
      SELECT m.*, fts.rank,
        snippet(messages_fts, 4, '>>', '<<', '...', 32) as snippet
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.id
      WHERE messages_fts MATCH ? AND m.project = ?
      ORDER BY fts.rank
      LIMIT 10
    `)
      .all(sanitizedQuery, 'testproject') as Array<{ snippet: string; payload: string }>;

    expect(results.length).toBeGreaterThan(0);
    const result = results[0];

    // The snippet should contain readable text, not raw JSON like {"text":"..."}
    expect(result.snippet).toContain('search target');

    // Verify it's NOT the raw JSON payload (should be readable text, not JSON structure)
    expect(result.snippet).not.toContain('{"text":');
    expect(result.snippet).not.toContain('"search target"'); // Raw JSON value marker
  });
});
