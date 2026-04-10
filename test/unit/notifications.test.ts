/**
 * Notification Tracking Unit Tests
 *
 * Tests for last-seen timestamp management functions:
 * - buildLastSeenKey: Key construction
 * - getLastSeenTimestamp: Reading timestamps from Redis
 * - updateLastSeenTimestamp: Writing timestamps to Redis
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { RedisClient } from '../../src/redis';
import { resetRedisClient, setRedisClient } from '../../src/redis';
import {
  buildLastSeenKey,
  getLastSeenTimestamp,
  updateLastSeenTimestamp,
} from '../../src/tools/notifications';
import { createTestContext, generateTestAgentId, type TestContext } from '../helpers';

// TTL constant used by notifications module
const EXPECTED_TTL_SECONDS = 86400; // 24 hours

/**
 * Generate a valid test project hash (lowercase hex only, 12 chars)
 */
function generateValidTestHash(): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

describe('notifications', () => {
  let ctx: TestContext;
  let redisWrapper: RedisClient;
  const projectHash = generateValidTestHash();
  const agentId = generateTestAgentId('notif');

  beforeAll(async () => {
    // Set up Redis wrapper for direct access
    ctx = createTestContext();
    await ctx.setup();
    redisWrapper = await createTestRedisWrapper();
    setRedisClient(redisWrapper);
  });

  afterAll(async () => {
    await redisWrapper.close();
    await ctx.cleanup();
    resetRedisClient();
  });

  describe('buildLastSeenKey', () => {
    test('builds correct key format', () => {
      const key = buildLastSeenKey(projectHash, agentId);
      expect(key).toBe(`opencode:${projectHash}:lastseen:${agentId}`);
    });

    test('uses lastseen key type', () => {
      const key = buildLastSeenKey(projectHash, agentId);
      expect(key).toContain(':lastseen:');
    });
  });

  describe('getLastSeenTimestamp', () => {
    test('T2.1: returns 0 when key missing', async () => {
      const timestamp = await getLastSeenTimestamp(projectHash, agentId);
      expect(timestamp).toBe(0);
    });

    test('T2.4: returns stored value after update', async () => {
      const key = buildLastSeenKey(projectHash, agentId);
      const testTimestamp = Date.now() - 3600000; // 1 hour ago

      // Set a known value directly
      await ctx.redis.set(key, testTimestamp.toString());

      try {
        const timestamp = await getLastSeenTimestamp(projectHash, agentId);
        expect(timestamp).toBe(testTimestamp);
      } finally {
        // Cleanup
        await ctx.redis.del(key);
      }
    });
  });

  describe('updateLastSeenTimestamp', () => {
    test('T2.2: sets correct value', async () => {
      const key = buildLastSeenKey(projectHash, agentId);

      await updateLastSeenTimestamp(projectHash, agentId);

      try {
        const value = await ctx.redis.get(key);
        expect(value).not.toBeNull();

        const timestamp = parseInt(value!, 10);
        const now = Date.now();
        // Allow 5 second tolerance for test execution time
        expect(Math.abs(timestamp - now)).toBeLessThan(5000);
      } finally {
        await ctx.redis.del(key);
      }
    });

    test('T2.3: sets 24h TTL', async () => {
      const key = buildLastSeenKey(projectHash, agentId);

      await updateLastSeenTimestamp(projectHash, agentId);

      try {
        const ttl = await ctx.redis.ttl(key);
        // TTL should be close to 86400 (within 5 seconds tolerance)
        expect(Math.abs(ttl - EXPECTED_TTL_SECONDS)).toBeLessThan(5);
      } finally {
        await ctx.redis.del(key);
      }
    });

    test('T2.5: handles Redis failure gracefully', async () => {
      // Disconnect Redis by forcing close
      redisWrapper.forceClose();

      try {
        // Should not throw - function should complete silently
        await updateLastSeenTimestamp(projectHash, agentId);
        // If we get here without throwing, the test passes
      } finally {
        // Reconnect for subsequent tests
        // Create a fresh client
        const { RedisClient } = await import('../../src/redis');
        const redisUrl = process.env.AGENTBUS_REDIS_URL ?? 'redis://localhost:6379';
        const newClient = new RedisClient({ url: redisUrl });
        setRedisClient(newClient);
      }
    });
  });
});

/**
 * Helper to create a Redis wrapper for testing
 */
async function createTestRedisWrapper(): Promise<RedisClient> {
  const { RedisClient } = await import('../../src/redis');
  const redisUrl = process.env.AGENTSYNCLAYER_REDIS_URL ?? 'redis://localhost:6379';
  const url = new URL(redisUrl);
  url.searchParams.set('db', '15');

  const client = new RedisClient({
    url: url.toString(),
    maxRetries: 3,
    retryDelayMs: 100,
  });

  await client.waitForConnection(5000);
  return client;
}
