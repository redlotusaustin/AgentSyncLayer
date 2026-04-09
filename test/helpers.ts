/**
 * Test helpers for AgentSyncLayer integration tests
 *
 * Provides Redis setup/teardown utilities using DB 15 for isolation.
 * All integration tests should use these helpers to ensure clean state.
 */

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Redis from 'ioredis';
import type { RedisClient } from '../src/redis';
import { resetBusConfig } from '../src/config';

// Test Redis configuration - use DB 15 for isolation
const TEST_REDIS_URL = process.env.AGENTSYNCLAYER_REDIS_URL ?? 'redis://localhost:6379';
const TEST_DB = 15;

/**
 * Parse Redis URL and add database parameter
 */
function buildTestRedisUrl(): string {
  const url = new URL(TEST_REDIS_URL);
  url.searchParams.set('db', TEST_DB.toString());
  return url.toString();
}

/**
 * Create a Redis client for testing
 */
export function createTestRedisClient(): Redis {
  const url = buildTestRedisUrl();
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    lazyConnect: true,
  });
}

/**
 * Create a RedisClient wrapper for testing
 */
export async function createTestRedisWrapper(): Promise<RedisClient> {
  const { RedisClient } = await import('../src/redis');
  const client = new RedisClient({
    url: buildTestRedisUrl(),
    maxRetries: 3,
    retryDelayMs: 100,
  });

  // Wait for connection
  await client.waitForConnection(5000);
  return client;
}

/**
 * Clear all test data from Redis DB 15
 */
export async function clearTestDatabase(client: Redis): Promise<void> {
  // Use FLUSHDB to clear only the test database
  await client.flushdb();
}

/**
 * Test context containing Redis client and cleanup functions
 */
export interface TestContext {
  redis: Redis;
  cleanup: () => Promise<void>;
}

/**
 * Set up a fresh test context with isolated Redis connection
 *
 * This also sets the RedisClient singleton used by bus tools,
 * so that busSendExecute, busReadExecute, etc. use the same connection.
 *
 * Usage:
 *   describe('Redis operations', () => {
 *     const ctx = createTestContext();
 *
 *     beforeAll(async () => {
 *       await ctx.setup();
 *     });
 *
 *     afterAll(async () => {
 *       await ctx.teardown();
 *     });
 *   });
 */
export function createTestContext(): TestContext {
  let redis: Redis | null = null;
  let originalRedisClient: { getClient: () => Redis; checkConnection: () => boolean } | null = null;

  return {
    get redis(): Redis {
      if (!redis) {
        throw new Error('Test context not initialized. Call setup() first.');
      }
      return redis;
    },

    async setup(): Promise<void> {
      // Import RedisClient and set it as the default
      const { RedisClient, setRedisClient, getRedisClient } = await import('../src/redis');

      // Save original client if exists
      try {
        originalRedisClient = getRedisClient();
      } catch {
        // No existing client
      }

      // Create new RedisClient for tests with DB 15
      const testClient = new RedisClient({
        url: buildTestRedisUrl(),
        maxRetries: 3,
        retryDelayMs: 100,
      });

      // Wait for connection
      await testClient.waitForConnection(5000);

      // Set as default client for bus tools
      setRedisClient(testClient);

      // Also create the raw Redis client for direct operations
      redis = createTestRedisClient();
      await redis.connect();
      await redis.ping();
    },

    async cleanup(): Promise<void> {
      if (redis) {
        try {
          // Clear test database before closing
          await redis.flushdb();
          await redis.quit();
        } catch {
          // Ignore cleanup errors
        }
        redis = null;
      }

      // Restore original RedisClient if it existed
      if (originalRedisClient) {
        const { setRedisClient } = await import('../src/redis');
        setRedisClient(originalRedisClient as any);
        originalRedisClient = null;
      }
    },

    async teardown(): Promise<void> {
      await this.cleanup();
    },
  };
}

/**
 * Generate a unique test project hash
 */
export function generateTestProjectHash(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp.toString(16)}${random}`.substring(0, 12);
}

/**
 * Generate a unique test agent ID
 */
export function generateTestAgentId(suffix?: string): string {
  const timestamp = Date.now();
  const random = suffix ?? Math.random().toString(16).substring(2, 6);
  return `test-${timestamp}-${random}`;
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

/**
 * Check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const testClient = createTestRedisClient();
    await testClient.connect();
    await testClient.ping();
    await testClient.quit();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the project hash for a test directory
 * This mirrors what the bus tools do internally
 */
export async function getTestProjectHash(directory: string): Promise<string> {
  // Dynamic import to avoid circular dependencies
  const { hashProjectPath } = await import('../src/namespace');
  return hashProjectPath(directory);
}

/**
 * Skip tests if Redis is not available
 */
export function skipIfNoRedis(): void {
  // This is a placeholder - actual skip happens in test files
}

/**
 * Mock time passage for rate limiter tests
 */
export class MockTime {
  private originalDateNow: typeof Date.now;
  private originalSetTimeout: typeof setTimeout;
  private currentTime: number;
  private timers: Map<number, { callback: () => void; duration: number }> = new Map();
  private timerId = 0;

  constructor(startTime?: number) {
    this.currentTime = startTime ?? Date.now();
    this.originalDateNow = Date.now;
    this.originalSetTimeout = setTimeout;
  }

  start(): void {
    const self = this;
    Date.now = () => self.currentTime;
    globalThis.setTimeout = ((callback: () => void, duration?: number) => {
      const id = ++self.timerId;
      if (duration !== undefined) {
        self.timers.set(id, { callback, duration });
        // Auto-fire timer
        self.originalSetTimeout(() => {
          if (self.timers.has(id)) {
            self.timers.delete(id);
            self.currentTime += duration;
            callback();
          }
        }, 0);
      }
      return id;
    }) as typeof setTimeout;
  }

  advance(ms: number): void {
    this.currentTime += ms;
    // Fire due timers
    for (const [id, timer] of this.timers) {
      if (timer.duration <= ms) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }

  stop(): void {
    Date.now = this.originalDateNow;
    globalThis.setTimeout = this.originalSetTimeout;
    this.timers.clear();
  }

  now(): number {
    return this.currentTime;
  }
}

/**
 * SQLite test database configuration
 */
const TEST_DB_PATH = '.agentsynclayer/history.db';

/**
 * Create a test SQLite database in a temporary directory
 *
 * Usage:
 *   const { db, dir, cleanup } = createTestSqliteDb();
 *   // use db...
 *   cleanup(); // when done
 *
 * @returns Object containing the Database instance, temp directory path, and cleanup function
 */
export function createTestSqliteDb(): {
  db: Database;
  dir: string;
  dbPath: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-test-'));
  const dbDir = path.join(dir, '.agentsynclayer');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'history.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  return {
    db,
    dir,
    dbPath,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // Already closed
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Directory may not exist
      }
    },
  };
}

/**
 * Test context for SQLite tests
 */
export interface TestSqliteContext {
  db: Database;
  dir: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Create an async test context for SQLite tests
 *
 * Usage:
 *   const ctx = createTestSqliteContext();
 *   beforeAll(async () => { await ctx.setup(); });
 *   afterAll(async () => { await ctx.teardown(); });
 */
export function createTestSqliteContext(): TestSqliteContext {
  let tempDir: string | null = null;

  return {
    get db(): Database {
      if (!tempDir) {
        throw new Error('Test SQLite context not initialized. Call setup() first.');
      }
      const dbPath = path.join(tempDir, '.agentsynclayer', 'history.db');
      return new Database(dbPath);
    },

    get dir(): string {
      if (!tempDir) {
        throw new Error('Test SQLite context not initialized. Call setup() first.');
      }
      return tempDir;
    },

    get dbPath(): string {
      if (!tempDir) {
        throw new Error('Test SQLite context not initialized. Call setup() first.');
      }
      return path.join(tempDir, '.agentsynclayer', 'history.db');
    },

    async setup(): Promise<void> {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-test-'));
      const dbDir = path.join(tempDir, '.agentsynclayer');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'history.db');
      // Create and close to ensure schema is initialized
      const db = new Database(dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          "from" TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'info',
          payload TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          project TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project, channel, created_at DESC);
        CREATE TABLE IF NOT EXISTS channels (
          name TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          id UNINDEXED, channel, "from", type UNINDEXED, payload,
          content=messages, content_rowid=rowid
        );
      `);
      db.close();
    },

    async cleanup(): Promise<void> {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Directory may not exist
        }
        tempDir = null;
      }
    },

    async teardown(): Promise<void> {
      await this.cleanup();
    },
  };
}

/**
 * Initialize SQLite schema on an existing database connection
 */
export function initializeTestSqliteSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      "from" TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      project TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project, channel, created_at DESC);
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED, channel, "from", type UNINDEXED, payload,
      content=messages, content_rowid=rowid
    );
  `);
}

// ============================================================================
// Config test helpers
// ============================================================================

/**
 * Create a temporary directory with optional .agentsynclayer.json config.
 *
 * Useful for testing config resolution from CWD or env vars.
 *
 * @param config - Optional .agentsynclayer.json content
 * @returns Object with root path and cleanup function
 *
 * @example
 * const { root, cleanup } = createTestBusEnv({ bus: '.' });
 * // root/.agentsynclayer.json will be created
 * cleanup();
 */
export function createTestBusEnv(
  config?: Record<string, string>
): {
  root: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-config-test-'));
  if (config) {
    fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify(config, null, 2));
  }
  return {
    root,
    cleanup: () => {
      resetBusConfig();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create a temporary directory tree for ancestor walk tests.
 *
 * Creates: root/packages/api, root/packages/web
 *
 * @returns Object with paths and cleanup function
 *
 * @example
 * const { root, sub1, sub2, cleanup } = createTestDirTree();
 * // Create config in root
 * fs.writeFileSync(path.join(root, '.agentsynclayer.json'), '{}');
 * // Test from sub1 - should find ancestor config
 * cleanup();
 */
export function createTestDirTree(): {
  root: string;
  sub1: string;
  sub2: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-tree-test-'));
  const sub1 = path.join(root, 'packages', 'api');
  const sub2 = path.join(root, 'packages', 'web');
  fs.mkdirSync(sub1, { recursive: true });
  fs.mkdirSync(sub2, { recursive: true });
  return {
    root,
    sub1,
    sub2,
    cleanup: () => {
      resetBusConfig();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
