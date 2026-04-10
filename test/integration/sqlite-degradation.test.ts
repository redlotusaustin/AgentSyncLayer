/**
 * SQLite Graceful Degradation Tests (T11.1-T11.4)
 *
 * Tests that AgentSyncLayer tools gracefully handle various combinations of
 * Redis and SQLite being available or unavailable.
 *
 * These tests require Redis to be available for most scenarios.
 * Tests will skip gracefully if Redis is not running.
 *
 * Note: Testing "SQLite unavailable" scenarios is limited because the
 * SQLite client is a singleton that re-initializes. We test the
 * fallback behavior instead.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSessionAgentId, setSessionAgentId } from '../../src/session';
import { closeSqliteClient, getSqliteClient } from '../../src/sqlite';
import { busChannelsExecute } from '../../src/tools/bus_channels';
import { busHistoryExecute } from '../../src/tools/bus_history';
import { busReadExecute } from '../../src/tools/bus_read';
import { busSearchExecute } from '../../src/tools/bus_search';
import { busSendExecute } from '../../src/tools/bus_send';
import type { Message } from '../../src/types';
import { createTestMessage } from '../fixtures';
import {
  createTestContext,
  generateTestAgentId,
  getTestProjectHash,
  isRedisAvailable,
} from '../helpers';

describe('T11: Graceful Degradation', () => {
  const ctx = createTestContext();
  let testDir: string;
  let projectHash: string;
  let agentId: string;
  let testCounter = 0;

  beforeAll(async () => {
    // Skip if Redis is not available
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Skipping degradation tests.');
    }

    await ctx.setup();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-degradation-'));
    agentId = generateTestAgentId('degradation-test');
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

  describe('T11.1: Redis-only mode (SQLite write fails gracefully)', () => {
    test('bus_send succeeds when SQLite write fails (continues with Redis only)', async () => {
      const channel = `t11-1-${testCounter}`;

      // Close SQLite to simulate unavailability
      closeSqliteClient(testDir);

      // bus_send should still work (Redis-only)
      const sendResult = await busSendExecute(
        { channel, message: 'Redis-only message' },
        { directory: testDir },
      );

      // Should succeed because Redis is available
      expect(sendResult.ok).toBe(true);

      // Re-initialize SQLite for remaining tests
      getSqliteClient(testDir, projectHash);
    });

    test('bus_channels works with Redis', async () => {
      const channelA = `t11-1a-${testCounter}`;
      const channelB = `t11-1b-${testCounter}`;

      // Set up some Redis data using the correct project hash
      await ctx.redis.sadd(`opencode:${projectHash}:channels`, channelA);
      await ctx.redis.sadd(`opencode:${projectHash}:channels`, channelB);

      // bus_channels should work
      const result = await busChannelsExecute({}, { directory: testDir });

      expect(result.ok).toBe(true);
      expect(result.data!.channels.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('T11.2: SQLite-only mode', () => {
    test('with Redis unavailable, bus_history works via SQLite', async () => {
      const channel = `t11-2a-${testCounter}`;

      // Insert message directly into SQLite
      const sqlite = getSqliteClient(testDir, projectHash);
      expect(sqlite).not.toBeNull();

      for (let i = 0; i < 3; i++) {
        const msg: Message = createTestMessage({
          id: `sqlite-only-msg-${testCounter}-${i}`,
          channel,
          payload: { text: `Direct SQLite message ${i}` },
          project: projectHash,
        });
        sqlite!.insertMessage(msg);
      }

      // Flush Redis to simulate it being down
      await ctx.redis.flushdb();

      // bus_history should work (SQLite-only)
      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );

      expect(historyResult.ok).toBe(true);
      // Find our messages by checking if there are any messages for this channel
      const ourMessages = historyResult.data!.messages.filter((m) =>
        m.id.startsWith(`sqlite-only-msg-${testCounter}`),
      );
      expect(ourMessages.length).toBe(3);
    });

    test('bus_search works with SQLite', async () => {
      const channel = `t11-2b-${testCounter}`;
      const uniqueTerm = `search-${Date.now()}-${testCounter}`;

      // Insert searchable messages
      const sqlite = getSqliteClient(testDir, projectHash);
      if (sqlite) {
        for (let i = 0; i < 5; i++) {
          const msg: Message = createTestMessage({
            id: `search-msg-${testCounter}-${i}`,
            channel,
            payload: { text: `Searchable content ${i} with ${uniqueTerm}` },
            project: projectHash,
          });
          sqlite.insertMessage(msg);
        }
      }

      // Flush Redis
      await ctx.redis.flushdb();

      // bus_search should work
      const searchResult = await busSearchExecute(
        { query: uniqueTerm, limit: 20 },
        { directory: testDir },
      );

      expect(searchResult.ok).toBe(true);
      // Should find our messages
      const ourResults = searchResult.data!.results.filter((r) =>
        r.message.id.startsWith(`search-msg-${testCounter}`),
      );
      expect(ourResults.length).toBe(5);
    });

    test('bus_read falls back to SQLite when Redis is down', async () => {
      const channel = `t11-2c-${testCounter}`;

      // Insert message into SQLite
      const sqlite = getSqliteClient(testDir, projectHash);
      if (sqlite) {
        const msg: Message = createTestMessage({
          id: `fallback-msg-${testCounter}`,
          channel,
          payload: { text: 'Fallback test message' },
          project: projectHash,
        });
        sqlite.insertMessage(msg);
      }

      // Flush Redis
      await ctx.redis.flushdb();

      // bus_read should fall back to SQLite
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      const ourMessage = readResult.data!.messages.find(
        (m) => m.id === `fallback-msg-${testCounter}`,
      );
      expect(ourMessage).toBeDefined();
      expect(ourMessage!.payload.text).toBe('Fallback test message');
    });
  });

  describe('T11.3: both stores behavior', () => {
    test('bus_read returns messages from SQLite when Redis is empty', async () => {
      const channel = `t11-3a-${testCounter}`;

      // Insert into SQLite
      const sqlite = getSqliteClient(testDir, projectHash);
      if (sqlite) {
        const msg: Message = createTestMessage({
          id: `test-msg-${testCounter}`,
          channel,
          payload: { text: 'Test message' },
          project: projectHash,
        });
        sqlite.insertMessage(msg);
      }

      // Redis should be empty after beforeEach
      await ctx.redis.flushdb();

      // bus_read should return from SQLite
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      const ourMessage = readResult.data!.messages.find((m) => m.id === `test-msg-${testCounter}`);
      expect(ourMessage).toBeDefined();
    });

    test('bus_history works with SQLite', async () => {
      const channel = `t11-3b-${testCounter}`;

      // bus_history should work (relies on SQLite)
      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );

      // Should return successfully (even if empty)
      expect(historyResult.ok).toBe(true);
    });

    test('bus_search works with SQLite', async () => {
      const query = `t11-3c-${testCounter}`;

      // bus_search should work
      const searchResult = await busSearchExecute({ query }, { directory: testDir });

      // Should return successfully (even if no results)
      expect(searchResult.ok).toBe(true);
    });
  });

  describe('T11.4: Redis reconnects after SQLite-only period', () => {
    test('after Redis-only period, tools use both stores again', async () => {
      const channel = `t11-4a-${testCounter}`;

      // Step 1: Redis is down, SQLite has data
      const sqlite = getSqliteClient(testDir, projectHash);
      if (sqlite) {
        sqlite.insertMessage(
          createTestMessage({
            id: `pre-reconnect-${testCounter}`,
            channel,
            payload: { text: 'Message during SQLite-only period' },
            project: projectHash,
          }),
        );
      }

      // Verify bus_history works with SQLite
      const historyBefore = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );
      expect(historyBefore.ok).toBe(true);
      const ourMsg = historyBefore.data!.messages.find(
        (m) => m.id === `pre-reconnect-${testCounter}`,
      );
      expect(ourMsg).toBeDefined();

      // Step 2: Redis comes back up (we simulate by flushing)
      await ctx.redis.flushdb();

      // Step 3: Send new message (goes to both Redis and SQLite)
      const sendResult = await busSendExecute(
        { channel, message: 'After reconnection' },
        { directory: testDir },
      );
      expect(sendResult.ok).toBe(true);

      // Step 4: Verify message is in Redis
      const historyKey = `opencode:${projectHash}:history:${channel}`;
      const redisCount = await ctx.redis.zcard(historyKey);
      expect(redisCount).toBe(1);

      // SQLite (via bus_history) should have both messages
      const historyAfter = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );
      expect(historyAfter.ok).toBe(true);
      const afterMsg = historyAfter.data!.messages.find(
        (m) => m.payload.text === 'After reconnection',
      );
      expect(afterMsg).toBeDefined();

      // bus_read should find message (uses Redis first)
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });
      expect(readResult.ok).toBe(true);
      expect(readResult.data!.messages.length).toBe(1); // From Redis cache
      expect(readResult.data!.messages[0].payload.text).toBe('After reconnection');
    });

    test('last-seen timestamps work after reconnection', async () => {
      const channel = `t11-4b-${testCounter}`;
      const lastSeenKey = `opencode:${projectHash}:lastseen:${agentId}`;

      // Set up Redis with a last-seen key
      await ctx.redis.set(lastSeenKey, Date.now().toString(), 'EX', 86400);

      // Insert new message in SQLite
      const sqlite = getSqliteClient(testDir, projectHash);
      if (sqlite) {
        sqlite.insertMessage(
          createTestMessage({
            id: `after-reconnect-${Date.now()}-${testCounter}`,
            channel,
            payload: { text: 'New message after timestamp check' },
            project: projectHash,
          }),
        );
      }

      // Update last-seen via bus_read
      await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      // Verify timestamp was updated in Redis
      const timestamp = await ctx.redis.get(lastSeenKey);
      expect(timestamp).not.toBeNull();
      expect(parseInt(timestamp!, 10)).toBeGreaterThan(0);
    });
  });
});
