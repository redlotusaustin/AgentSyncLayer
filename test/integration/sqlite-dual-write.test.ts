/**
 * SQLite Dual-Write Consistency Tests (T8.1-T8.5)
 *
 * Tests that messages are consistently written to both Redis and SQLite,
 * and that data remains consistent across both stores during normal operation.
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
import { busHistoryExecute } from '../../src/tools/bus_history';
import { busReadExecute } from '../../src/tools/bus_read';
import { busSearchExecute } from '../../src/tools/bus_search';
import { busSendExecute } from '../../src/tools/bus_send';
import {
  createTestContext,
  generateTestAgentId,
  getTestProjectHash,
  isRedisAvailable,
} from '../helpers';

describe('T8: Dual-Write Consistency', () => {
  const ctx = createTestContext();
  let testDir: string;
  let projectHash: string;
  let agentId: string;
  let testCounter = 0;

  beforeAll(async () => {
    // Skip if Redis is not available
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Skipping dual-write tests.');
    }

    await ctx.setup();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-dualwrite-'));
    agentId = generateTestAgentId('sender');
    setSessionAgentId(agentId);

    // Get the actual project hash that bus tools will use
    projectHash = await getTestProjectHash(testDir);

    // Initialize SQLite client for this test suite
    getSqliteClient(testDir, projectHash);
  });

  afterAll(async () => {
    // Cleanup SQLite client
    closeSqliteClient(testDir);

    // Clean up temp directory
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
    // Clear Redis for isolation
    await ctx.redis.flushdb();
  });

  describe('T8.1: send then read from Redis', () => {
    test('send via bus_send, read via bus_read shows message in response', async () => {
      const channel = `t8-1-${testCounter}`;

      // Send a message
      const sendResult = await busSendExecute(
        { channel, message: 'Hello from test' },
        { directory: testDir },
      );

      expect(sendResult.ok).toBe(true);
      expect(sendResult.data).toBeDefined();
      const messageId = sendResult.data!.id;

      // Read it back via bus_read (Redis first)
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      expect(readResult.data).toBeDefined();
      expect(readResult.data!.messages.length).toBeGreaterThan(0);

      // Find our message
      const ourMessage = readResult.data!.messages.find((m) => m.id === messageId);
      expect(ourMessage).toBeDefined();
      expect(ourMessage!.payload.text).toBe('Hello from test');
    });
  });

  describe('T8.2: send then read from SQLite via bus_history', () => {
    test('send via bus_send, read via bus_history shows message in response', async () => {
      const channel = `t8-2-${testCounter}`;

      // Send a message
      const sendResult = await busSendExecute(
        { channel, message: 'Persistent message' },
        { directory: testDir },
      );

      expect(sendResult.ok).toBe(true);
      const messageId = sendResult.data!.id;

      // Read via bus_history (SQLite)
      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );

      expect(historyResult.ok).toBe(true);
      expect(historyResult.data).toBeDefined();
      expect(historyResult.data!.messages.length).toBeGreaterThan(0);

      // Find our message
      const ourMessage = historyResult.data!.messages.find((m) => m.id === messageId);
      expect(ourMessage).toBeDefined();
      expect(ourMessage!.payload.text).toBe('Persistent message');
    });

    test('bus_history returns messages in correct order (newest first)', async () => {
      const channel = `t8-2-order-${testCounter}`;

      // Send multiple messages
      for (let i = 0; i < 5; i++) {
        await busSendExecute({ channel, message: `Message ${i}` }, { directory: testDir });
      }

      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 10 },
        { directory: testDir },
      );

      expect(historyResult.ok).toBe(true);
      const messages = historyResult.data!.messages;

      // Should be in newest-first order
      for (let i = 0; i < messages.length - 1; i++) {
        const current = new Date(messages[i].timestamp).getTime();
        const next = new Date(messages[i + 1].timestamp).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });
  });

  describe('T8.3: send then search via bus_search', () => {
    test('send via bus_send, search for payload text finds match', async () => {
      const channel = `t8-3-search-${testCounter}`;
      const uniqueSearchTerm = `unique-term-${Date.now()}-${testCounter}`;

      // Send a message with unique searchable content
      const sendResult = await busSendExecute(
        { channel, message: `This contains ${uniqueSearchTerm} for searching` },
        { directory: testDir },
      );

      expect(sendResult.ok).toBe(true);

      // Search for it
      const searchResult = await busSearchExecute(
        { query: uniqueSearchTerm, limit: 20 },
        { directory: testDir },
      );

      expect(searchResult.ok).toBe(true);
      expect(searchResult.data).toBeDefined();
      expect(searchResult.data!.count).toBeGreaterThan(0);

      // Verify the search found our message
      const found = searchResult.data!.results.some((r) =>
        r.message.payload.text.includes(uniqueSearchTerm),
      );
      expect(found).toBe(true);
    });

    test('bus_search returns snippet with delimiters', async () => {
      const channel = `t8-3-snippet-${testCounter}`;
      const term = `snippet-${Date.now()}`;

      await busSendExecute(
        { channel, message: `Here is the ${term} to find in the text` },
        { directory: testDir },
      );

      const searchResult = await busSearchExecute(
        { query: term, limit: 10 },
        { directory: testDir },
      );

      expect(searchResult.ok).toBe(true);
      if (searchResult.data!.count > 0) {
        const snippet = searchResult.data!.results[0].snippet;
        // Should contain delimiters
        expect(snippet).toMatch(/>>|<</);
      }
    });
  });

  describe('T8.4: send survives Redis restart simulation', () => {
    test('send, flush Redis DB, read via bus_history shows message persists', async () => {
      const channel = `t8-4-${testCounter}`;

      // Send a message
      const sendResult = await busSendExecute(
        { channel, message: 'Should persist in SQLite' },
        { directory: testDir },
      );

      expect(sendResult.ok).toBe(true);
      const messageId = sendResult.data!.id;

      // Simulate Redis restart by flushing Redis DB
      await ctx.redis.flushdb();

      // Verify Redis is empty
      const keys = await ctx.redis.keys('*');
      expect(keys).toHaveLength(0);

      // But bus_history should still return the message from SQLite
      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );

      expect(historyResult.ok).toBe(true);
      const found = historyResult.data!.messages.some((m) => m.id === messageId);
      expect(found).toBe(true);
    });
  });

  describe('T8.5: multiple agents see same history', () => {
    test('Agent A sends, Agent B reads via bus_history sees message', async () => {
      const channel = `t8-5a-${testCounter}`;
      const agentA = generateTestAgentId('agentA');
      const agentB = generateTestAgentId('agentB');

      // Agent A sends a message
      setSessionAgentId(agentA);
      const sendResult = await busSendExecute(
        { channel, message: 'Shared message from Agent A' },
        { directory: testDir },
      );

      expect(sendResult.ok).toBe(true);
      const messageId = sendResult.data!.id;

      // Agent B reads history
      setSessionAgentId(agentB);
      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir },
      );

      expect(historyResult.ok).toBe(true);
      const found = historyResult.data!.messages.some((m) => m.id === messageId);
      expect(found).toBe(true);

      // Restore original agent
      setSessionAgentId(agentId);
    });

    test('Agent A sends, Agent B reads via bus_read sees message', async () => {
      const channel = `t8-5b-${testCounter}`;
      const agentA = generateTestAgentId('agentA2');
      const agentB = generateTestAgentId('agentB2');

      // Agent A sends
      setSessionAgentId(agentA);
      const sendResult = await busSendExecute(
        { channel, message: 'Shared via bus_read' },
        { directory: testDir },
      );

      expect(sendResult.ok).toBe(true);

      // Agent B reads (uses Redis cache first, should find it)
      setSessionAgentId(agentB);
      const readResult = await busReadExecute({ channel, limit: 10 }, { directory: testDir });

      expect(readResult.ok).toBe(true);
      expect(readResult.data!.messages.length).toBeGreaterThan(0);

      // Restore original agent
      setSessionAgentId(agentId);
    });
  });
});
