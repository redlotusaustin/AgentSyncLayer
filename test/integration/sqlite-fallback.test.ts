/**
 * SQLite Fallback Behavior Tests (T9.1-T9.3)
 *
 * Tests that bus_read correctly falls back to SQLite when Redis is unavailable,
 * and that bus_listen continues to work independently of SQLite state.
 *
 * These tests require both Redis and SQLite to be available.
 * Tests will skip gracefully if Redis is not running.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSessionAgentId, setSessionAgentId } from '../../src/session';
import { closeSqliteClient, getSqliteClient } from '../../src/sqlite';
import { busListenExecute } from '../../src/tools/bus_listen';
import { busReadExecute } from '../../src/tools/bus_read';
import { busSendExecute } from '../../src/tools/bus_send';
import type { Message } from '../../src/types';
import { createTestMessage } from '../fixtures';
import {
  createTestContext,
  generateTestAgentId,
  getTestProjectHash,
  isRedisAvailable,
} from '../helpers';

describe('T9: Fallback Behavior', () => {
  const ctx = createTestContext();
  let testDir: string;
  let projectHash: string;
  let agentId: string;
  let testCounter = 0;

  beforeAll(async () => {
    // Skip if Redis is not available
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Skipping fallback tests.');
    }

    await ctx.setup();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-fallback-'));
    agentId = generateTestAgentId('fallback-test');
    setSessionAgentId(agentId);

    // Get the actual project hash that bus tools will use
    projectHash = await getTestProjectHash(testDir);

    // Initialize SQLite client
    getSqliteClient(testDir, projectHash);
  });

  afterAll(async () => {
    closeSqliteClient(testDir);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    resetSessionAgentId();
    await ctx.teardown();
  });

  beforeEach(async () => {
    testCounter++;
    await ctx.redis.flushdb();
  });

  describe('T9.1: bus_read falls back after Redis flush', () => {
    test('send 5 messages, flush Redis, call bus_read verifies messages from SQLite', async () => {
      const channel = `t9-1-${testCounter}`;

      // Send 5 messages via bus_send (writes to both Redis and SQLite)
      const messageIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const result = await busSendExecute(
          { channel, message: `Message ${i}` },
          { directory: testDir },
        );
        expect(result.ok).toBe(true);
        messageIds.push(result.data!.id);
      }

      // Verify messages are in Redis
      const historyKey = `opencode:${projectHash}:history:${channel}`;
      const redisCount = await ctx.redis.zcard(historyKey);
      expect(redisCount).toBe(5);

      // Flush Redis
      await ctx.redis.flushdb();

      // Verify Redis is empty
      const emptyCount = await ctx.redis.zcard(historyKey);
      expect(emptyCount).toBe(0);

      // bus_read should now fall back to SQLite
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      expect(readResult.data).toBeDefined();
      expect(readResult.data!.messages.length).toBe(5);

      // Verify all our messages are in the result
      const readIds = readResult.data!.messages.map((m) => m.id);
      for (const id of messageIds) {
        expect(readIds).toContain(id);
      }
    });
  });

  describe('T9.2: bus_read uses Redis when populated', () => {
    test('send message, call bus_read verifies response from Redis', async () => {
      const channel = `t9-2-redis-${testCounter}`;
      const historyKey = `opencode:${projectHash}:history:${channel}`;
      const channelsKey = `opencode:${projectHash}:channels`;
      const now = Date.now();

      // Directly insert into Redis using the correct project hash
      const message: Message = createTestMessage({
        id: `redis-msg-${testCounter}`,
        channel,
        payload: { text: 'Direct Redis message' },
        timestamp: new Date(now).toISOString(),
        project: projectHash,
      });

      await ctx.redis.zadd(historyKey, now, JSON.stringify(message));
      await ctx.redis.sadd(channelsKey, channel);

      // bus_read should use Redis (fast path)
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      expect(readResult.data!.messages.length).toBe(1);
      expect(readResult.data!.messages[0].id).toBe(`redis-msg-${testCounter}`);
    });

    test('message in both Redis and SQLite returns same data', async () => {
      const channel = `t9-2-both-${testCounter}`;

      // Send a message (goes to both stores)
      const sendResult = await busSendExecute(
        { channel, message: 'Message in both stores' },
        { directory: testDir },
      );
      expect(sendResult.ok).toBe(true);
      const messageId = sendResult.data!.id;

      // Read back
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      const ourMessage = readResult.data!.messages.find((m) => m.id === messageId);
      expect(ourMessage).toBeDefined();
      expect(ourMessage!.payload.text).toBe('Message in both stores');
    });
  });

  describe('T9.3: bus_listen unaffected by SQLite state', () => {
    test('bus_listen returns timeout when no new messages arrive', async () => {
      const channel = `t9-3a-${testCounter}`;
      const historyKey = `opencode:${projectHash}:history:${channel}`;
      const channelsKey = `opencode:${projectHash}:channels`;
      const now = Date.now();

      // Insert message from a DIFFERENT agent (bus_listen filters out own messages)
      const otherAgent = generateTestAgentId('other-agent');
      const message: Message = createTestMessage({
        id: `listen-msg-${testCounter}`,
        from: otherAgent,
        channel,
        payload: { text: 'Existing message' },
        timestamp: new Date(now).toISOString(),
        project: projectHash,
      });

      await ctx.redis.zadd(historyKey, now, JSON.stringify(message));
      await ctx.redis.sadd(channelsKey, channel);

      // Note: bus_listen looks for NEW messages (timestamp > latest in channel).
      // Since the message is already in the channel, bus_listen will timeout
      // looking for messages after it. This is expected behavior.
      // The important thing is that bus_listen WORKS (returns timeout, not error).

      const listenResult = await busListenExecute(
        { channels: [channel], timeout: 2 },
        { directory: testDir },
      );

      // bus_listen should succeed (not return BUS_UNAVAILABLE)
      expect(listenResult.ok).toBe(true);
      expect(listenResult.data).toBeDefined();

      expect(listenResult.data!.timeout).toBe(true);
    });

    test('bus_listen completes successfully when channel is empty', async () => {
      const channel = `t9-3b-${testCounter}`;
      const channelsKey = `opencode:${projectHash}:channels`;

      // Add channel but don't add any messages
      await ctx.redis.sadd(channelsKey, channel);

      const listenResult = await busListenExecute(
        { channels: [channel], timeout: 1 },
        { directory: testDir },
      );

      // Should complete successfully (timeout is expected)
      expect(listenResult.ok).toBe(true);

      expect(listenResult.data!.timeout).toBe(true);
    });
  });
});
