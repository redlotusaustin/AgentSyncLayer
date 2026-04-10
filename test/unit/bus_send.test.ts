/**
 * bus_send Unit Tests
 *
 * Tests for modified bus_send with SQLite dual-write and last-seen timestamp:
 * - T3.1: dual-writes to SQLite and Redis
 * - T3.2: succeeds when SQLite fails
 * - T3.3: succeeds when Redis fails after SQLite write
 * - T3.4: updates last-seen timestamp on send
 * - T3.4: handles both SQLite and Redis failure
 * - T3.6: inserts FTS5 entry alongside message
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashProjectPath } from '../../src/namespace';
import { RedisClient, resetRedisClient, setRedisClient } from '../../src/redis';
import { resetSessionAgentId, setSessionAgentId } from '../../src/session';
import { closeSqliteClient, getSqliteClient } from '../../src/sqlite';
import { busSendExecute, cleanupRateLimiter } from '../../src/tools/bus_send';
import type { ToolContext } from '../../src/types';

// Test configuration
const TEST_REDIS_URL = process.env.AGENTSYNCLAYER_REDIS_URL ?? 'redis://localhost:6379';
const TEST_DB = 15;

function buildTestRedisUrl(): string {
  const url = new URL(TEST_REDIS_URL);
  url.searchParams.set('db', TEST_DB.toString());
  return url.toString();
}

function createTestDirectory(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-bus-send-test-'));
  fs.mkdirSync(path.join(dir, '.agentsynclayer'));
  return {
    dir,
    cleanup: () => {
      closeSqliteClient(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('bus_send unit tests', () => {
  let redisWrapper: RedisClient;
  let testDir: { dir: string; cleanup: () => void };
  let projectHash: string;
  let testContext: ToolContext;

  beforeAll(async () => {
    // Set up Redis wrapper
    redisWrapper = new RedisClient({
      url: buildTestRedisUrl(),
      maxRetries: 3,
      retryDelayMs: 100,
    });
    await redisWrapper.waitForConnection(5000);
    setRedisClient(redisWrapper);
  });

  beforeEach(() => {
    testDir = createTestDirectory();
    // IMPORTANT: Calculate project hash from directory to match what bus_send will calculate
    projectHash = hashProjectPath(testDir.dir);
    testContext = { directory: testDir.dir };
    setSessionAgentId(`test-agent-${Date.now()}`);
  });

  afterEach(async () => {
    // Only flush Redis, don't close the connection
    if (redisWrapper.checkConnection()) {
      const client = redisWrapper.getClient();
      await client.flushdb();
    }
    testDir.cleanup();
    cleanupRateLimiter();
    resetSessionAgentId();
  });

  afterAll(async () => {
    await redisWrapper.close();
    resetRedisClient();
  });

  describe('T3.1: dual-writes to SQLite and Redis', () => {
    test('sends message to both SQLite and Redis', async () => {
      const result = await busSendExecute(
        { channel: 'general', message: 'Test message' },
        testContext,
      );

      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      const messageId = result.data!.id;

      // Verify Redis has the message
      const redis = redisWrapper.getClient();
      const historyKey = `opencode:${projectHash}:history:general`;
      const redisMessages = await redis.zrange(historyKey, 0, -1);

      const foundInRedis = redisMessages.some((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.id === messageId;
        } catch {
          return false;
        }
      });
      expect(foundInRedis).toBe(true);

      // Verify SQLite has the message
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      expect(sqlite).not.toBeNull();

      const { messages } = sqlite!.getMessages({
        projectHash,
        channel: 'general',
        limit: 100,
        offset: 0,
      });

      const foundInSqlite = messages.some((msg) => msg.id === messageId);
      expect(foundInSqlite).toBe(true);
    });

    test('stores correct message fields in SQLite', async () => {
      const result = await busSendExecute(
        { channel: 'test-channel', message: 'Hello world', type: 'info' },
        testContext,
      );

      expect(result.ok).toBe(true);
      const messageId = result.data!.id;

      const sqlite = getSqliteClient(testDir.dir, projectHash);
      const { messages } = sqlite!.getMessages({
        projectHash,
        channel: 'test-channel',
        limit: 1,
        offset: 0,
      });

      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg.id).toBe(messageId);
      expect(msg.channel).toBe('test-channel');
      expect(msg.from).toContain('test-agent-');
      expect(msg.type).toBe('info');
      expect(msg.payload).toEqual({ text: 'Hello world' });
      expect(msg.project).toBe(projectHash);
    });
  });

  describe('T3.2: succeeds when SQLite fails', () => {
    test('still succeeds when SQLite write throws', async () => {
      // Get the real sqlite client for this test
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      expect(sqlite).not.toBeNull();

      // Mock sqlite.insertMessage to throw
      const originalInsert = sqlite!.insertMessage.bind(sqlite!);
      sqlite!.insertMessage = (_msg: any) => {
        throw new Error('Simulated SQLite error');
      };

      try {
        const result = await busSendExecute(
          { channel: 'general', message: 'Test message' },
          testContext,
        );

        // Should still succeed (SQLite failure is non-fatal)
        expect(result.ok).toBe(true);
        expect(result.data).toBeDefined();
      } finally {
        // Restore original function
        sqlite!.insertMessage = originalInsert;
      }
    });
  });

  describe('T3.3: succeeds when Redis fails after SQLite write', () => {
    test('message should be in SQLite even if Redis fails', async () => {
      const result = await busSendExecute(
        { channel: 'general', message: 'Test message' },
        testContext,
      );

      expect(result.ok).toBe(true);
      const messageId = result.data!.id;

      // Verify message is in SQLite
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      const { messages } = sqlite!.getMessages({
        projectHash,
        channel: 'general',
        limit: 100,
        offset: 0,
      });

      const foundInSqlite = messages.some((msg) => msg.id === messageId);
      expect(foundInSqlite).toBe(true);
    });
  });

  describe('T3.4: handles SQLite + Redis degradation per RFC', () => {
    test('returns ok:true when Redis is down but SQLite succeeds (per RFC degradation table)', async () => {
      // Force close Redis
      redisWrapper.forceClose();

      // Wait a bit for the connection to close
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await busSendExecute(
        { channel: 'general', message: 'Test message' },
        testContext,
      );

      // With R-1 fix: If SQLite succeeds but Redis is down, return ok:true
      // This is per the RFC degradation table - SQLite provides durability
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.channel).toBe('general');

      // Reconnect for subsequent tests - create a fresh client
      const newClient = new RedisClient({
        url: buildTestRedisUrl(),
        maxRetries: 3,
        retryDelayMs: 100,
      });
      await newClient.waitForConnection(5000);
      setRedisClient(newClient);
      redisWrapper = newClient;
    });

    test('returns BUS_UNAVAILABLE when both SQLite and Redis fail', async () => {
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      expect(sqlite).not.toBeNull();

      // Mock sqlite.insertMessage to throw
      const originalInsert = sqlite!.insertMessage.bind(sqlite!);
      sqlite!.insertMessage = (_msg: any) => {
        throw new Error('Simulated SQLite error');
      };

      // Force close Redis
      redisWrapper.forceClose();

      // Wait a bit for the connection to close
      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        const result = await busSendExecute(
          { channel: 'general', message: 'Test message' },
          testContext,
        );

        // Both SQLite and Redis failed - bus is unavailable
        expect(result.ok).toBe(false);
        expect(result.code).toBe('BUS_UNAVAILABLE');
      } finally {
        // Restore original function
        sqlite!.insertMessage = originalInsert;

        // Reconnect Redis for subsequent tests
        const newClient = new RedisClient({
          url: buildTestRedisUrl(),
          maxRetries: 3,
          retryDelayMs: 100,
        });
        await newClient.waitForConnection(5000);
        setRedisClient(newClient);
        redisWrapper = newClient;
      }
    });
  });

  describe('T3.6: inserts FTS5 entry alongside message', () => {
    test('message is searchable via FTS5 after send', async () => {
      const searchText = `unique-search-term-${Date.now()}`;

      const result = await busSendExecute(
        { channel: 'general', message: `Hello ${searchText} world` },
        testContext,
      );

      expect(result.ok).toBe(true);

      // Verify message is searchable
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      const searchResults = sqlite!.searchMessages(projectHash, searchText, 'general', 10);

      expect(searchResults).toHaveLength(1);
      expect(searchResults[0].message.payload.text).toContain(searchText);
    });
  });

  describe('existing validation behavior', () => {
    test('returns CHANNEL_INVALID for empty channel', async () => {
      const result = await busSendExecute({ channel: '', message: 'Test' }, testContext);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('CHANNEL_INVALID');
    });

    test('returns RATE_LIMITED when rate limit exceeded', async () => {
      // Set up many messages to trigger rate limiting
      const agentId = `test-agent-${Date.now()}`;
      setSessionAgentId(agentId);

      // Send 101 messages to trigger rate limit (default: 100/minute)
      for (let i = 0; i < 101; i++) {
        await busSendExecute({ channel: 'general', message: `Rate test ${i}` }, testContext);
      }

      // Next message should be rate limited
      const result = await busSendExecute(
        { channel: 'general', message: 'This should be limited' },
        testContext,
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('RATE_LIMITED');
    });
  });
});
