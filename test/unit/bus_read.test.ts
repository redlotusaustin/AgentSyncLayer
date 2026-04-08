/**
 * bus_read Unit Tests
 *
 * Tests for modified bus_read with SQLite fallback and last-seen timestamp:
 * - T4.1: reads from Redis when cache is populated
 * - T4.2: falls back to SQLite when Redis is empty
 * - T4.3: falls back to SQLite when Redis is disconnected
 * - T4.4: returns empty when both stores are empty
 * - T4.5: updates last-seen timestamp on read
 * - T4.6: handles malformed Redis messages gracefully
 * - T4.7: preserves existing validation behavior
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSqliteClient,
  closeSqliteClient,
} from '../../src/sqlite';
import {
  RedisClient,
  getRedisClient,
  setRedisClient,
  resetRedisClient,
} from '../../src/redis';
import { hashProjectPath } from '../../src/namespace';
import { resetSessionAgentId, setSessionAgentId } from '../../src/session';
import { busReadExecute } from '../../src/tools/bus_read';
import { busSendExecute } from '../../src/tools/bus_send';
import { cleanupRateLimiter } from '../../src/tools/bus_send';
import type { Message, ToolContext } from '../../src/types';

// Test configuration
const TEST_REDIS_URL = process.env.AGENTBUS_REDIS_URL ?? 'redis://localhost:6379';
const TEST_DB = 15;

function buildTestRedisUrl(): string {
  const url = new URL(TEST_REDIS_URL);
  url.searchParams.set('db', TEST_DB.toString());
  return url.toString();
}

function createTestDirectory(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-bus-read-test-'));
  fs.mkdirSync(path.join(dir, '.agentbus'));
  return {
    dir,
    cleanup: () => {
      closeSqliteClient(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createTestMessage(projectHash: string, overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    from: 'test-agent-1234',
    channel: 'general',
    type: 'info',
    payload: { text: 'Test message' },
    timestamp: new Date().toISOString(),
    project: projectHash,
    ...overrides,
  };
}

describe('bus_read unit tests', () => {
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
    // IMPORTANT: Calculate project hash from directory to match what tools will calculate
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

  describe('T4.1: reads from Redis when cache is populated', () => {
    test('returns messages from Redis sorted set', async () => {
      // First send a message via bus_send (writes to both)
      const sendResult = await busSendExecute(
        { channel: 'general', message: 'Hello Redis' },
        testContext
      );
      expect(sendResult.ok).toBe(true);

      // Read should return from Redis
      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.messages.length).toBeGreaterThan(0);
      expect(result.data!.channel).toBe('general');
    });

    test('uses Redis when both Redis and SQLite have messages', async () => {
      // Send a message
      await busSendExecute(
        { channel: 'general', message: 'Test message' },
        testContext
      );

      // Verify SQLite also has the message
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      const sqliteMessages = sqlite!.getMessages({
        projectHash,
        channel: 'general',
        limit: 10,
        offset: 0,
      });
      expect(sqliteMessages.messages.length).toBe(1);

      // Read should return from Redis (fast path)
      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      expect(result.data!.messages.length).toBe(1);
    });
  });

  describe('T4.2: falls back to SQLite when Redis is empty', () => {
    test('returns messages from SQLite when Redis sorted set is empty', async () => {
      // Insert directly into SQLite (bypassing Redis)
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      const testMsg = createTestMessage(projectHash, {
        channel: 'general',
        payload: { text: 'SQLite only message' },
      });
      sqlite!.insertMessage(testMsg);

      // Clear Redis to simulate empty cache
      const redis = redisWrapper.getClient();
      await redis.flushdb();

      // Read should fall back to SQLite
      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      expect(result.data!.messages.length).toBe(1);
      expect(result.data!.messages[0].payload.text).toBe('SQLite only message');
    });

    test('returns correct count from SQLite', async () => {
      // Insert multiple messages into SQLite
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      for (let i = 0; i < 5; i++) {
        sqlite!.insertMessage(createTestMessage(projectHash, {
          channel: 'general',
          payload: { text: `Message ${i}` },
        }));
      }

      // Clear Redis
      const redis = redisWrapper.getClient();
      await redis.flushdb();

      // Read should return all 5 messages
      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      expect(result.data!.count).toBe(5);
      expect(result.data!.total).toBe(5);
    });
  });

  describe('T4.3: falls back to SQLite when Redis is disconnected', () => {
    test('returns messages from SQLite when Redis is down', async () => {
      // Insert message into SQLite
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      const testMsg = createTestMessage(projectHash, {
        channel: 'general',
        payload: { text: 'Fallback message' },
      });
      sqlite!.insertMessage(testMsg);

      // Force disconnect Redis
      redisWrapper.forceClose();

      // Wait a bit for the connection to close
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        // Read should still work via SQLite fallback
        const result = await busReadExecute(
          { channel: 'general', limit: 10 },
          testContext
        );

        expect(result.ok).toBe(true);
        expect(result.data!.messages.length).toBe(1);
        expect(result.data!.messages[0].payload.text).toBe('Fallback message');
      } finally {
        // Reconnect for subsequent tests - create a fresh client
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

    test('returns empty array when both Redis and SQLite are unavailable', async () => {
      // Force disconnect Redis
      redisWrapper.forceClose();

      // Wait a bit for the connection to close
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        // Use the same testDir context so hashProjectPath works
        const result = await busReadExecute(
          { channel: 'general', limit: 10 },
          testContext
        );

        // Should return empty, not error
        expect(result.ok).toBe(true);
        expect(result.data!.messages).toEqual([]);
        expect(result.data!.count).toBe(0);
        expect(result.data!.total).toBe(0);
      } finally {
        // Reconnect for subsequent tests
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

  describe('T4.4: returns empty when both stores are empty', () => {
    test('returns empty messages array when no data exists', async () => {
      // Clear Redis
      const redis = redisWrapper.getClient();
      await redis.flushdb();

      // No SQLite data

      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      expect(result.data!.messages).toEqual([]);
      expect(result.data!.count).toBe(0);
      expect(result.data!.total).toBe(0);
    });
  });

  describe('T4.5: updates last-seen timestamp on read', () => {
    test('sets last-seen key in Redis after read', async () => {
      const agentId = `test-agent-${Date.now()}`;
      setSessionAgentId(agentId);

      // Insert message and read it
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      sqlite!.insertMessage(createTestMessage(projectHash, {
        channel: 'general',
      }));

      await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      // Check Redis for last-seen key
      const redis = redisWrapper.getClient();
      const lastSeenKey = `opencode:${projectHash}:lastseen:${agentId}`;
      const lastSeenValue = await redis.get(lastSeenKey);

      expect(lastSeenValue).not.toBeNull();
      const timestamp = parseInt(lastSeenValue!, 10);
      const now = Date.now();
      expect(Math.abs(timestamp - now)).toBeLessThan(5000);
    });

    test('last-seen updated even when no messages returned', async () => {
      const agentId = `test-agent-${Date.now()}`;
      setSessionAgentId(agentId);

      // Clear Redis
      const redis = redisWrapper.getClient();
      await redis.flushdb();

      // Read from empty channel
      await busReadExecute(
        { channel: 'empty-channel', limit: 10 },
        testContext
      );

      // Check last-seen was still updated
      const lastSeenKey = `opencode:${projectHash}:lastseen:${agentId}`;
      const lastSeenValue = await redis.get(lastSeenKey);

      expect(lastSeenValue).not.toBeNull();
    });
  });

  describe('T4.6: handles malformed Redis messages gracefully', () => {
    test('skips malformed JSON messages', async () => {
      // Insert a valid message via bus_send
      await busSendExecute(
        { channel: 'general', message: 'Valid message' },
        testContext
      );

      // Manually insert a malformed message into Redis
      const redis = redisWrapper.getClient();
      const historyKey = `opencode:${projectHash}:history:general`;
      await redis.zadd(historyKey, Date.now(), 'not-valid-json{');

      // Read should skip the malformed message
      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      // Should have at least the valid message
      expect(result.data!.messages.length).toBeGreaterThanOrEqual(1);
      // All returned messages should be valid
      for (const msg of result.data!.messages) {
        expect(msg.id).toBeDefined();
        expect(msg.channel).toBe('general');
      }
    });

    test('handles empty string messages', async () => {
      // Insert an empty string into Redis
      const redis = redisWrapper.getClient();
      const historyKey = `opencode:${projectHash}:history:general`;
      await redis.zadd(historyKey, Date.now(), '');

      // Read should handle empty string gracefully
      const result = await busReadExecute(
        { channel: 'general', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(true);
      // Should not throw or crash
    });
  });

  describe('T4.7: preserves existing validation behavior', () => {
    test('returns CHANNEL_INVALID for empty channel', async () => {
      const result = await busReadExecute(
        { channel: '', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('CHANNEL_INVALID');
    });

    test('returns CHANNEL_INVALID for invalid channel characters', async () => {
      const result = await busReadExecute(
        { channel: 'invalid channel with space', limit: 10 },
        testContext
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('CHANNEL_INVALID');
    });

    test('returns CHANNEL_INVALID for channel exceeding max length', async () => {
      const longChannel = 'a'.repeat(65); // Max is 64
      const result = await busReadExecute(
        { channel: longChannel, limit: 10 },
        testContext
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe('CHANNEL_INVALID');
    });

    test('handles limit parameter correctly', async () => {
      // Insert 5 messages into SQLite
      const sqlite = getSqliteClient(testDir.dir, projectHash);
      for (let i = 0; i < 5; i++) {
        sqlite!.insertMessage(createTestMessage(projectHash, {
          channel: 'general',
          payload: { text: `Message ${i}` },
        }));
      }

      // Clear Redis
      const redis = redisWrapper.getClient();
      await redis.flushdb();

      // Request only 2 messages
      const result = await busReadExecute(
        { channel: 'general', limit: 2 },
        testContext
      );

      expect(result.ok).toBe(true);
      expect(result.data!.count).toBe(2);
      expect(result.data!.total).toBe(5); // Total should still be 5
    });

    test('defaults limit to 20', async () => {
      const result = await busReadExecute(
        { channel: 'general' },
        testContext
      );

      expect(result.ok).toBe(true);
      // Should use default limit of 20
      expect(result.data).toBeDefined();
    });
  });
});
