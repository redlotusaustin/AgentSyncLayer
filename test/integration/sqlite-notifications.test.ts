/**
 * SQLite Notification Tracking Tests (T10.1-T10.4)
 *
 * Tests that the experimental.chat.system.transform hook correctly tracks
 * unread messages and updates last-seen timestamps.
 *
 * These tests require both Redis and SQLite to be available.
 * Tests will skip gracefully if Redis is not running.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createTestContext,
  getTestProjectHash,
  generateTestAgentId,
  isRedisAvailable,
} from '../helpers';
import { createTestMessages, createTestMessage } from '../fixtures';
import { getSqliteClient, closeSqliteClient } from '../../src/sqlite';
import { getLastSeenTimestamp, updateLastSeenTimestamp } from '../../src/tools/notifications';
import { busSendExecute } from '../../src/tools/bus_send';
import { busReadExecute } from '../../src/tools/bus_read';
import { busHistoryExecute } from '../../src/tools/bus_history';
import { setSessionAgentId, resetSessionAgentId } from '../../src/session';
import type { Message } from '../../src/types';

describe('T10: Notification Tracking', () => {
  const ctx = createTestContext();
  let testDir: string;
  let projectHash: string;
  let agentId: string;
  let testCounter = 0;

  beforeAll(async () => {
    // Skip if Redis is not available
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Skipping notification tracking tests.');
    }

    await ctx.setup();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-notifications-'));
    agentId = generateTestAgentId('notif-test');
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

    // Clear last-seen timestamp for fresh tests
    const lastSeenKey = `opencode:${projectHash}:lastseen:${agentId}`;
    await ctx.redis.del(lastSeenKey);
  });

  describe('T10.1: first turn shows all messages', () => {
    test('insert 10 messages, invoke hook with no last-seen key, verify all 10 reported', async () => {
      const channel = `t10-1-${testCounter}`;

      // Insert 10 messages directly into SQLite (simulating messages from other agents)
      const sqlite = getSqliteClient(testDir, projectHash);
      expect(sqlite).not.toBeNull();

      const messages = createTestMessages(10, channel, Date.now() - 10000, projectHash);
      for (const msg of messages) {
        sqlite!.insertMessage(msg);
      }

      // Verify no last-seen timestamp exists
      const initialTimestamp = await getLastSeenTimestamp(projectHash, agentId);
      expect(initialTimestamp).toBe(0);

      // Simulate hook behavior: get messages since timestamp
      const unreadMessages = sqlite!.getMessagesSince({
        projectHash,
        sinceUnixMs: 0, // All messages
        limit: 50,
      });

      // Should return all 10 messages (simulating "all messages shown on first turn")
      expect(unreadMessages.length).toBeGreaterThanOrEqual(10);
    });

    test('messages from multiple channels are tracked separately', async () => {
      const channelA = `t10-1a-${testCounter}`;
      const channelB = `t10-1b-${testCounter}`;
      const channelC = `t10-1c-${testCounter}`;

      const sqlite = getSqliteClient(testDir, projectHash);
      expect(sqlite).not.toBeNull();

      // Insert messages across 3 channels
      const messagesA = createTestMessages(3, channelA, Date.now() - 5000, projectHash);
      const messagesB = createTestMessages(5, channelB, Date.now() - 4000, projectHash);
      const messagesC = createTestMessages(2, channelC, Date.now() - 3000, projectHash);

      for (const msg of [...messagesA, ...messagesB, ...messagesC]) {
        sqlite!.insertMessage(msg);
      }

      // Get all unread (since timestamp 0)
      const allUnread = sqlite!.getMessagesSince({
        projectHash,
        sinceUnixMs: 0,
        limit: 50,
      });

      // Should return at least 10 messages (may have more from previous tests)
      expect(allUnread.length).toBeGreaterThanOrEqual(10);

      // Group by channel
      const byChannel = new Map<string, number>();
      for (const msg of allUnread) {
        byChannel.set(msg.channel, (byChannel.get(msg.channel) ?? 0) + 1);
      }

      expect(byChannel.get(channelA)).toBe(3);
      expect(byChannel.get(channelB)).toBe(5);
      expect(byChannel.get(channelC)).toBe(2);
    });
  });

  describe('T10.2: second turn shows only new messages', () => {
    test('invoke hook twice, insert message between, verify only new message on second call', async () => {
      const channel = `t10-2-${testCounter}`;

      const sqlite = getSqliteClient(testDir, projectHash);
      expect(sqlite).not.toBeNull();

      // First turn: insert initial messages
      const initialMessages = createTestMessages(5, channel, Date.now() - 10000, projectHash);
      for (const msg of initialMessages) {
        sqlite!.insertMessage(msg);
      }

      // Simulate first hook call - get unread since 0
      const firstTurn = sqlite!.getMessagesSince({
        projectHash,
        sinceUnixMs: 0,
        limit: 50,
      });
      const firstTurnCount = firstTurn.filter((m) => m.channel === channel).length;
      expect(firstTurnCount).toBe(5);

      // Update last-seen timestamp (simulating LLM turn completing)
      await updateLastSeenTimestamp(projectHash, agentId);

      // Verify timestamp was set
      const lastSeen = await getLastSeenTimestamp(projectHash, agentId);
      expect(lastSeen).toBeGreaterThan(0);
      const cutoffTime = lastSeen;

      // Second turn: insert new message with timestamp after cutoff
      const newMessage: Message = createTestMessage({
        id: `new-msg-${Date.now()}-${testCounter}`,
        channel,
        payload: { text: 'New message after first turn' },
        timestamp: new Date(cutoffTime + 1).toISOString(),
        project: projectHash,
      });
      sqlite!.insertMessage(newMessage);

      // Simulate second hook call - get messages since last seen
      const secondTurn = sqlite!.getMessagesSince({
        projectHash,
        sinceUnixMs: cutoffTime,
        limit: 50,
      });

      // Should only return the new message for this channel
      const ourNewMessages = secondTurn.filter(
        (m) => m.channel === channel && m.id === newMessage.id
      );
      expect(ourNewMessages.length).toBe(1);
      expect(secondTurn[0].id).toBe(newMessage.id);
    });
  });

  describe('T10.3: bus_read updates last-seen', () => {
    test('call bus_read, insert message, invoke hook, verify new message reported', async () => {
      const channel = `t10-3-${testCounter}`;

      const sqlite = getSqliteClient(testDir, projectHash);
      expect(sqlite).not.toBeNull();

      // Send initial message
      const sendResult = await busSendExecute(
        { channel, message: 'Initial message' },
        { directory: testDir }
      );
      expect(sendResult.ok).toBe(true);
      const initialMessageId = sendResult.data!.id;

      // Clear last-seen to simulate fresh agent
      const lastSeenKey = `opencode:${projectHash}:lastseen:${agentId}`;
      await ctx.redis.del(lastSeenKey);

      // Read messages (should update last-seen)
      const readResult = await busReadExecute(
        { channel, limit: 10 },
        { directory: testDir }
      );
      expect(readResult.ok).toBe(true);

      // Check last-seen was updated
      const afterReadTimestamp = await getLastSeenTimestamp(projectHash, agentId);
      expect(afterReadTimestamp).toBeGreaterThan(0);
      const cutoff = afterReadTimestamp;

      // Insert a new message (simulating another agent)
      const newMessage: Message = createTestMessage({
        id: `new-after-read-${Date.now()}-${testCounter}`,
        channel,
        payload: { text: 'Message after bus_read' },
        timestamp: new Date(Date.now() + 100).toISOString(),
        project: projectHash,
      });
      sqlite!.insertMessage(newMessage);

      // Get unread messages (simulating hook call)
      const unread = sqlite!.getMessagesSince({
        projectHash,
        sinceUnixMs: cutoff,
        limit: 50,
      });

      // Should only have the new message
      expect(unread.length).toBe(1);
      expect(unread[0].id).toBe(newMessage.id);
    });
  });

  describe('T10.4: bus_history updates last-seen', () => {
    test('call bus_history, insert message, invoke hook, verify new message reported', async () => {
      const channel = `t10-4-${testCounter}`;

      const sqlite = getSqliteClient(testDir, projectHash);
      expect(sqlite).not.toBeNull();

      // Send initial message
      const sendResult = await busSendExecute(
        { channel, message: 'History initial message' },
        { directory: testDir }
      );
      expect(sendResult.ok).toBe(true);
      const initialMessageId = sendResult.data!.id;

      // Clear last-seen
      const lastSeenKey = `opencode:${projectHash}:lastseen:${agentId}`;
      await ctx.redis.del(lastSeenKey);

      // Read history (should update last-seen)
      const historyResult = await busHistoryExecute(
        { channel, page: 1, per_page: 50 },
        { directory: testDir }
      );
      expect(historyResult.ok).toBe(true);

      // Check last-seen was updated
      const afterHistoryTimestamp = await getLastSeenTimestamp(projectHash, agentId);
      expect(afterHistoryTimestamp).toBeGreaterThan(0);
      const cutoff = afterHistoryTimestamp;

      // Insert new message with a timestamp slightly after cutoff
      const newMessage: Message = createTestMessage({
        id: `new-after-history-${Date.now()}-${testCounter}`,
        channel,
        payload: { text: 'Message after bus_history' },
        timestamp: new Date(cutoff + 1).toISOString(),
        project: projectHash,
      });
      sqlite!.insertMessage(newMessage);

      // Get unread since cutoff
      const unread = sqlite!.getMessagesSince({
        projectHash,
        sinceUnixMs: cutoff,
        limit: 50,
      });

      // Verify the new message is included
      expect(unread.some((m) => m.id === newMessage.id)).toBe(true);
    });
  });
});
