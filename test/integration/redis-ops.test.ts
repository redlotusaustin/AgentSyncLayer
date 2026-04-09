/**
 * Redis Operations Integration Tests
 *
 * Tests Redis-backed operations for AgentSyncLayer including:
 * - Message publishing and reading
 * - Channel management
 * - Agent status storage with TTL
 * - File claim operations
 *
 * These tests require a running Redis server on localhost:6379
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import Redis from 'ioredis';
import {
  createTestContext,
  createTestRedisClient,
  generateTestProjectHash,
  generateTestAgentId,
  waitFor,
  isRedisAvailable,
} from '../helpers';
import type { Message } from '../../src/types';

describe('Redis Operations', () => {
  const ctx = createTestContext();
  const projectHash = generateTestProjectHash();
  let redis: Redis;

  beforeAll(async () => {
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Please start Redis server on localhost:6379');
    }
    await ctx.setup();
    redis = ctx.redis;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    // Clear database before each test for isolation
    await redis.flushdb();
  });

  describe('Channel operations', () => {
    test('stores and retrieves channel membership', async () => {
      const channelsKey = `opencode:${projectHash}:channels`;
      const channelName = 'general';

      // Add channel to channels set
      await redis.sadd(channelsKey, channelName);

      // Verify channel is in set
      const channels = await redis.smembers(channelsKey);
      expect(channels).toContain(channelName);
    });

    test('tracks multiple channels', async () => {
      const channelsKey = `opencode:${projectHash}:channels`;
      const channels = ['general', 'errors', 'claims'];

      await redis.sadd(channelsKey, ...channels);

      const stored = await redis.smembers(channelsKey);
      expect(stored).toHaveLength(3);
      expect(stored).toEqual(expect.arrayContaining(channels));
    });

    test('removes channels from set', async () => {
      const channelsKey = `opencode:${projectHash}:channels`;
      await redis.sadd(channelsKey, 'test-channel');

      await redis.srem(channelsKey, 'test-channel');

      const channels = await redis.smembers(channelsKey);
      expect(channels).not.toContain('test-channel');
    });
  });

  describe('Message history (sorted set)', () => {
    test('stores messages with timestamp score', async () => {
      const historyKey = `opencode:${projectHash}:history:general`;
      const now = Date.now();

      const message1: Message = {
        id: 'msg-1',
        from: 'agent-1',
        channel: 'general',
        type: 'info',
        payload: { text: 'First message' },
        timestamp: new Date(now).toISOString(),
        project: projectHash,
      };

      const message2: Message = {
        id: 'msg-2',
        from: 'agent-2',
        channel: 'general',
        type: 'info',
        payload: { text: 'Second message' },
        timestamp: new Date(now + 100).toISOString(),
        project: projectHash,
      };

      // Store with score = timestamp
      await redis.zadd(historyKey, now, JSON.stringify(message1));
      await redis.zadd(historyKey, now + 100, JSON.stringify(message2));

      // Retrieve newest first
      const messages = await redis.zrevrange(historyKey, 0, -1);
      expect(messages).toHaveLength(2);
      expect(JSON.parse(messages[0]).id).toBe('msg-2');
      expect(JSON.parse(messages[1]).id).toBe('msg-1');
    });

    test('limits message retrieval by count', async () => {
      const historyKey = `opencode:${projectHash}:history:general`;
      const now = Date.now();

      // Store 10 messages
      for (let i = 0; i < 10; i++) {
        const msg: Message = {
          id: `msg-${i}`,
          from: 'agent-1',
          channel: 'general',
          type: 'info',
          payload: { text: `Message ${i}` },
          timestamp: new Date(now + i * 10).toISOString(),
          project: projectHash,
        };
        await redis.zadd(historyKey, now + i * 10, JSON.stringify(msg));
      }

      // Retrieve only 5
      const messages = await redis.zrevrange(historyKey, 0, 4);
      expect(messages).toHaveLength(5);
    });

    test('counts messages in channel', async () => {
      const historyKey = `opencode:${projectHash}:history:general`;
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        const msg: Message = {
          id: `msg-${i}`,
          from: 'agent-1',
          channel: 'general',
          type: 'info',
          payload: { text: `Message ${i}` },
          timestamp: new Date(now + i * 10).toISOString(),
          project: projectHash,
        };
        await redis.zadd(historyKey, now + i * 10, JSON.stringify(msg));
      }

      const count = await redis.zcard(historyKey);
      expect(count).toBe(5);
    });
  });

  describe('Agent status (hash with TTL)', () => {
    test('stores agent status with TTL', async () => {
      const agentId = generateTestAgentId();
      const agentKey = `opencode:${projectHash}:agent:${agentId}`;
      const ttlSeconds = 90;

      const status = {
        id: agentId,
        task: 'Working on feature X',
        files: ['src/a.ts', 'src/b.ts'],
        claimedFiles: [],
        channels: ['general', 'errors'],
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };

      // Store as hash with EXPIRE
      await redis.hset(agentKey, 'status', JSON.stringify(status));
      await redis.expire(agentKey, ttlSeconds);

      // Verify data
      const stored = await redis.hget(agentKey, 'status');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).id).toBe(agentId);

      // Verify TTL
      const ttl = await redis.ttl(agentKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(ttlSeconds);
    });

    test('auto-expires agent status after TTL', async () => {
      const agentId = generateTestAgentId();
      const agentKey = `opencode:${projectHash}:agent:${agentId}`;

      // Set with 1 second TTL for testing
      await redis.hset(agentKey, 'status', JSON.stringify({ id: agentId }));
      await redis.expire(agentKey, 1);

      // Should exist immediately
      expect(await redis.exists(agentKey)).toBe(1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be gone
      expect(await redis.exists(agentKey)).toBe(0);
    });

    test('scans all agents in project', async () => {
      const agentPattern = `opencode:${projectHash}:agent:*`;

      // Create 3 agent statuses
      for (let i = 0; i < 3; i++) {
        const agentId = generateTestAgentId(`agent${i}`);
        const agentKey = `opencode:${projectHash}:agent:${agentId}`;
        await redis.hset(agentKey, 'status', JSON.stringify({ id: agentId }));
        await redis.expire(agentKey, 90);
      }

      // Scan for all agents
      const agentKeys: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', agentPattern, 'COUNT', 100);
        cursor = nextCursor;
        agentKeys.push(...keys);
      } while (cursor !== '0');

      expect(agentKeys).toHaveLength(3);
    });
  });

  describe('File claims (atomic operations)', () => {
    test('creates file claim atomically', async () => {
      const path = 'src/important.ts';
      const agentId = generateTestAgentId();
      const claimKey = `opencode:${projectHash}:claim:${path}`;
      const ttlSeconds = 300;

      // Try to claim using SETNX (set if not exists)
      const claimed = await redis.set(claimKey, JSON.stringify({
        path,
        agentId,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      }), 'EX', ttlSeconds, 'NX');

      expect(claimed).toBe('OK');

      // Verify claim exists
      const data = await redis.get(claimKey);
      expect(data).not.toBeNull();
      expect(JSON.parse(data!).agentId).toBe(agentId);
    });

    test('rejects duplicate claim by different agent', async () => {
      const path = 'src/shared.ts';
      const agent1 = generateTestAgentId('agent1');
      const agent2 = generateTestAgentId('agent2');
      const claimKey = `opencode:${projectHash}:claim:${path}`;

      // First agent claims
      await redis.set(claimKey, JSON.stringify({
        path,
        agentId: agent1,
        claimedAt: new Date().toISOString(),
      }), 'EX', 300, 'NX');

      // Second agent tries to claim same file
      const claimed = await redis.set(claimKey, JSON.stringify({
        path,
        agentId: agent2,
        claimedAt: new Date().toISOString(),
      }), 'EX', 300, 'NX');

      expect(claimed).toBeNull(); // Should fail

      // Original claim still exists
      const data = await redis.get(claimKey);
      expect(JSON.parse(data!).agentId).toBe(agent1);
    });

    test('owner can release their claim', async () => {
      const path = 'src/temp.ts';
      const agentId = generateTestAgentId();
      const claimKey = `opencode:${projectHash}:claim:${path}`;

      // Create claim
      await redis.set(claimKey, JSON.stringify({
        path,
        agentId,
        claimedAt: new Date().toISOString(),
      }), 'EX', 300, 'NX');

      // Verify exists
      expect(await redis.exists(claimKey)).toBe(1);

      // Release (delete) - in real impl, this would use Lua script for atomicity
      await redis.del(claimKey);

      // Verify gone
      expect(await redis.exists(claimKey)).toBe(0);
    });

    test('scans all claims in project', async () => {
      const claimPattern = `opencode:${projectHash}:claim:*`;
      const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

      // Create claims
      for (const path of paths) {
        const claimKey = `opencode:${projectHash}:claim:${path}`;
        await redis.set(claimKey, JSON.stringify({
          path,
          agentId: generateTestAgentId(),
          claimedAt: new Date().toISOString(),
        }), 'EX', 300, 'NX');
      }

      // Scan
      const claimKeys: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', claimPattern, 'COUNT', 100);
        cursor = nextCursor;
        claimKeys.push(...keys);
      } while (cursor !== '0');

      expect(claimKeys).toHaveLength(3);
    });
  });

  describe('Pub/Sub functionality', () => {
    test('publishes and receives messages', async () => {
      const channel = `opencode:${projectHash}:ch:general`;
      const received: string[] = [];

      // Create a separate subscriber client (required by ioredis)
      const subscriber = createTestRedisClient();
      await subscriber.connect();

      // Subscribe using the subscriber client
      await subscriber.subscribe(channel);
      subscriber.on('message', (ch, msg) => {
        if (ch === channel) {
          received.push(msg);
        }
      });

      // Give subscription time to establish
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Publish using main client
      const msg: Message = {
        id: 'pub-sub-test',
        from: 'agent-publisher',
        channel: 'general',
        type: 'info',
        payload: { text: 'Test message' },
        timestamp: new Date().toISOString(),
        project: projectHash,
      };

      await redis.publish(channel, JSON.stringify(msg));

      // Wait for message
      const found = await waitFor(async () => received.length > 0, 2000);
      expect(found).toBe(true);
      expect(JSON.parse(received[0]).id).toBe('pub-sub-test');

      // Cleanup subscriber
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    });
  });

  describe('Project isolation', () => {
    test('different projects have isolated data', async () => {
      const projectA = generateTestProjectHash();
      const projectB = generateTestProjectHash();

      const channelA = `opencode:${projectA}:ch:general`;
      const channelB = `opencode:${projectB}:ch:general`;
      const channelsA = `opencode:${projectA}:channels`;
      const channelsB = `opencode:${projectB}:channels`;

      // Create channel A data
      await redis.sadd(channelsA, 'general');
      await redis.zadd(channelA, Date.now(), JSON.stringify({ id: 'a-msg' }));

      // Create channel B data
      await redis.sadd(channelsB, 'general');
      await redis.zadd(channelB, Date.now(), JSON.stringify({ id: 'b-msg' }));

      // Verify isolation
      expect(await redis.smembers(channelsA)).toEqual(['general']);
      expect(await redis.smembers(channelsB)).toEqual(['general']);
      expect(await redis.zrange(channelA, 0, -1)).toHaveLength(1);
      expect(await redis.zrange(channelB, 0, -1)).toHaveLength(1);
    });
  });
});
