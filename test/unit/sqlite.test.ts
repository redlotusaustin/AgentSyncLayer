import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database } from 'bun:sqlite';
import {
  SqliteClient,
  SqliteInitializationError,
  getSqliteClient,
  closeSqliteClient,
} from '../../src/sqlite';
import type { Message } from '../../src/types';

// Test helper to create a temporary SQLite database
function createTestSqliteDb(): { db: Database; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-sqlite-test-'));
  fs.mkdirSync(path.join(dir, '.agentbus'));
  const dbPath = path.join(dir, '.agentbus', 'history.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Test helper to create a test message
function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    from: 'testagent-1234-abcd',
    channel: 'general',
    type: 'info',
    payload: { text: 'Test message' },
    timestamp: new Date().toISOString(),
    project: 'a1b2c3d4e5f6',
    ...overrides,
  };
}

describe('T1.1: initializes database with correct schema', () => {
  const { db, cleanup } = createTestSqliteDb();
  afterAll(cleanup);

  test('creates messages table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    expect(result).toBeDefined();
  });

  test('creates channels table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'").get();
    expect(result).toBeDefined();
  });

  test('creates FTS5 virtual table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
    expect(result).toBeDefined();
  });

  test('enables WAL mode', () => {
    const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result.journal_mode.toLowerCase()).toBe('wal');
  });
});

describe('T1.2: idempotent initialization', () => {
  const { dir, cleanup } = createTestSqliteDb();
  afterAll(cleanup);

  test('getSqliteClient returns same instance for same directory', () => {
    const projectHash = 'a1b2c3d4e5f6';
    const client1 = getSqliteClient(dir, projectHash);
    const client2 = getSqliteClient(dir, projectHash);

    expect(client1).toBe(client2);
    expect(client1).not.toBeNull();

    closeSqliteClient(dir);
  });
});

describe('T1.3: insertMessage persists message', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
  });
  afterAll(cleanup);

  test('inserts message and retrieves it', () => {
    const msg = createTestMessage({ id: 'test-msg-001', channel: 'general' });
    client.insertMessage(msg);

    const { messages } = client.getMessages({ projectHash, limit: 10, offset: 0 });
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe('test-msg-001');
    expect(messages[0].from).toBe(msg.from);
    expect(messages[0].channel).toBe(msg.channel);
    expect(messages[0].type).toBe(msg.type);
    expect(messages[0].payload).toEqual(msg.payload);
    expect(messages[0].project).toBe(projectHash);
  });
});

describe('T1.4: insertMessage ignores duplicate IDs', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
  });
  afterAll(cleanup);

  test('inserts same ID twice, only one row exists', () => {
    const msg = createTestMessage({ id: 'test-msg-duplicate' });
    client.insertMessage(msg);
    client.insertMessage(msg);

    const { messages } = client.getMessages({ projectHash, limit: 10, offset: 0 });
    expect(messages.length).toBe(1);
  });
});

describe('T1.5: insertMessage upserts channel count', () => {
  const { db, dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
  });
  afterAll(cleanup);

  test('inserts 3 messages to same channel, channel count is 3', () => {
    client.insertMessage(createTestMessage({ channel: 'upsert-test' }));
    client.insertMessage(createTestMessage({ channel: 'upsert-test' }));
    client.insertMessage(createTestMessage({ channel: 'upsert-test' }));

    const result = db.prepare('SELECT message_count FROM channels WHERE name = ?').get('upsert-test') as { message_count: number };
    expect(result.message_count).toBe(3);
  });
});

describe('T1.6: getMessages with channel filter', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    // Insert 5 messages to channel A, 3 to channel B
    for (let i = 0; i < 5; i++) {
      client.insertMessage(createTestMessage({ channel: 'channel-a', id: `msg-a-${i}` }));
    }
    for (let i = 0; i < 3; i++) {
      client.insertMessage(createTestMessage({ channel: 'channel-b', id: `msg-b-${i}` }));
    }
  });
  afterAll(cleanup);

  test('filters by channel correctly', () => {
    const { messages } = client.getMessages({
      projectHash,
      channel: 'channel-a',
      limit: 10,
      offset: 0,
    });
    expect(messages.length).toBe(5);
    messages.forEach(msg => {
      expect(msg.channel).toBe('channel-a');
    });
  });
});

describe('T1.7: getMessages pagination', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    // Insert 100 messages with decreasing timestamps
    for (let i = 0; i < 100; i++) {
      const timestamp = new Date(Date.now() - (100 - i) * 1000).toISOString();
      client.insertMessage(createTestMessage({ id: `msg-pag-${i}`, timestamp }));
    }
  });
  afterAll(cleanup);

  test('page 1 returns first 10 messages (newest)', () => {
    const { messages } = client.getMessages({ projectHash, limit: 10, offset: 0 });
    expect(messages.length).toBe(10);
  });

  test('page 2 returns messages 11-20', () => {
    const { messages } = client.getMessages({ projectHash, limit: 10, offset: 10 });
    expect(messages.length).toBe(10);
    // First message on page 2 should be msg-pag-89 (index 89)
    expect(messages[0].id).toBe('msg-pag-89');
  });
});

describe('T1.8: getMessages total count accuracy', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    // Insert 25 messages
    for (let i = 0; i < 25; i++) {
      client.insertMessage(createTestMessage({ id: `msg-total-${i}` }));
    }
  });
  afterAll(cleanup);

  test('total is 25 even when limit is 10', () => {
    const { messages, total } = client.getMessages({ projectHash, limit: 10, offset: 0 });
    expect(messages.length).toBe(10);
    expect(total).toBe(25);
  });
});

describe('T1.9: getMessagesSince returns only newer messages', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    // Insert messages at baseTime, baseTime+1000, baseTime+2000
    // Store baseTime for use in test
    (globalThis as any).__testBaseTime = Date.now();
  });
  afterAll(cleanup);

  test('returns only messages after sinceUnixMs', () => {
    const baseTime = (globalThis as any).__testBaseTime as number;
    // Insert messages with explicit timestamps relative to baseTime
    client.insertMessage(createTestMessage({ id: 'msg-since-1', timestamp: new Date(baseTime).toISOString() }));
    client.insertMessage(createTestMessage({ id: 'msg-since-2', timestamp: new Date(baseTime + 1000).toISOString() }));
    client.insertMessage(createTestMessage({ id: 'msg-since-3', timestamp: new Date(baseTime + 2000).toISOString() }));

    // Query for messages after baseTime + 500
    const sinceTime = baseTime + 500;
    const messages = client.getMessagesSince({ projectHash, sinceUnixMs: sinceTime });
    // Should return messages at baseTime+1000 and baseTime+2000
    expect(messages.length).toBe(2);
    const ids = messages.map(m => m.id);
    expect(ids).toContain('msg-since-2');
    expect(ids).toContain('msg-since-3');
  });
});

describe('T1.10: getMessagesSince with limit', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    // Insert 100 messages
    for (let i = 0; i < 100; i++) {
      client.insertMessage(createTestMessage({ id: `msg-limit-${i}` }));
    }
  });
  afterAll(cleanup);

  test('returns only limit messages', () => {
    const sinceTime = 0; // all messages
    const messages = client.getMessagesSince({ projectHash, sinceUnixMs: sinceTime, limit: 10 });
    expect(messages.length).toBe(10);
  });
});

describe('T1.11: searchMessages finds matching text', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    client.insertMessage(createTestMessage({
      id: 'msg-search-1',
      payload: { text: 'implement authentication' },
    }));
    client.insertMessage(createTestMessage({
      id: 'msg-search-2',
      payload: { text: 'fix database connection' },
    }));
  });
  afterAll(cleanup);

  test('finds message with matching text', () => {
    const results = client.searchMessages(projectHash, 'authentication', null, 10);
    expect(results.length).toBe(1);
    expect(results[0].message.id).toBe('msg-search-1');
  });
});

describe('T1.12: searchMessages with channel filter', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    client.insertMessage(createTestMessage({
      id: 'msg-ch-filter-1',
      channel: 'general',
      payload: { text: 'search query match' },
    }));
    client.insertMessage(createTestMessage({
      id: 'msg-ch-filter-2',
      channel: 'claims',
      payload: { text: 'search query match' },
    }));
  });
  afterAll(cleanup);

  test('filters by channel correctly', () => {
    const results = client.searchMessages(projectHash, 'search query', 'general', 10);
    expect(results.length).toBe(1);
    expect(results[0].message.id).toBe('msg-ch-filter-1');
  });
});

describe('T1.13: searchMessages returns snippet', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    client.insertMessage(createTestMessage({
      id: 'msg-snippet-1',
      payload: { text: 'this is a test message with matching text inside' },
    }));
  });
  afterAll(cleanup);

  test('snippet contains delimiters', () => {
    const results = client.searchMessages(projectHash, 'matching', null, 10);
    expect(results.length).toBe(1);
    expect(results[0].snippet).toContain('>>');
    expect(results[0].snippet).toContain('<<');
  });
});

describe('T1.14: searchMessages ranks by relevance', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    client.insertMessage(createTestMessage({
      id: 'msg-rank-1',
      payload: { text: 'error handling error recovery' }, // 2 occurrences
    }));
    client.insertMessage(createTestMessage({
      id: 'msg-rank-2',
      payload: { text: 'error handling' }, // 1 occurrence
    }));
  });
  afterAll(cleanup);

  test('higher rank (lower number) for more matches', () => {
    const results = client.searchMessages(projectHash, 'error', null, 10);
    expect(results.length).toBe(2);
    // Rank is ordered by relevance, so msg-rank-1 should come first
    expect(results[0].message.id).toBe('msg-rank-1');
    expect(results[1].message.id).toBe('msg-rank-2');
  });
});

describe('T1.15: searchMessages sanitizes FTS5 query', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;
  const projectHash = 'a1b2c3d4e5f6';

  beforeAll(() => {
    client = new SqliteClient(dir, projectHash);
    client.insertMessage(createTestMessage({
      id: 'msg-sanitize',
      payload: { text: 'this is a normal test message' },
    }));
  });
  afterAll(cleanup);

  test('handles special characters without SQL injection', () => {
    // This should not throw and should handle gracefully
    const results = client.searchMessages(projectHash, '"test; DROP TABLE messages--"', null, 10);
    // Should not throw, may return empty results or handle safely
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('T1.16: close sets available to false', () => {
  const { dir, cleanup } = createTestSqliteDb();
  let client: SqliteClient;

  beforeAll(() => {
    client = new SqliteClient(dir, 'a1b2c3d4e5f6');
  });
  afterAll(cleanup);

  test('available is true before close', () => {
    expect(client.available).toBe(true);
  });

  test('available is false after close', () => {
    client.close();
    expect(client.available).toBe(false);
  });
});

describe('T1.17: constructor fails gracefully on invalid path', () => {
  test('throws SqliteInitializationError on invalid path', () => {
    expect(() => {
      // Use a path that cannot be created
      new SqliteClient('/root/impossible/path', 'a1b2c3d4e5f6');
    }).toThrow(SqliteInitializationError);
  });
});

describe('T1.18: getSqliteClient returns null on failure', () => {
  test('returns null when constructor throws', () => {
    // Mock behavior: using an impossible path should result in null
    const result = getSqliteClient('/root/impossible/path', 'a1b2c3d4e5f6');
    expect(result).toBeNull();
  });
});
