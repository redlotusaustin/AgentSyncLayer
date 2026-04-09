/**
 * Multi-Instance Communication Tests
 *
 * Tests that two agents can exchange messages through Redis.
 * This verifies the core AgentSyncLayer functionality for inter-agent communication.
 *
 * Tests:
 * - Agent A sends message, Agent B reads it
 * - Both agents can see each other's status
 * - Claims are visible across instances
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
  createTestContext,
  createTestRedisClient,
  generateTestProjectHash,
  generateTestAgentId,
  waitFor,
  isRedisAvailable,
} from '../helpers';

describe('Multi-Instance Communication', () => {
  const ctx = createTestContext();
  let redis: ReturnType<typeof createTestContext>['redis'];
  let projectHash: string;

  // Two agents for communication test
  const agentA = {
    id: '',
    statusKey: '',
  };
  const agentB = {
    id: '',
    statusKey: '',
  };

  beforeAll(async () => {
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Please start Redis server on localhost:6379');
    }
    await ctx.setup();
    redis = ctx.redis;
    projectHash = generateTestProjectHash();

    // Initialize agent IDs
    agentA.id = generateTestAgentId('agentA');
    agentB.id = generateTestAgentId('agentB');
    agentA.statusKey = `opencode:${projectHash}:agent:${agentA.id}`;
    agentB.statusKey = `opencode:${projectHash}:agent:${agentB.id}`;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('Agent presence', () => {
    test('both agents can register their status', async () => {
      const statusA = {
        id: agentA.id,
        task: 'Implementing feature X',
        files: ['src/feature-x.ts'],
        claimedFiles: [],
        channels: ['general'],
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };

      const statusB = {
        id: agentB.id,
        task: 'Reviewing code',
        files: ['src/feature-y.ts'],
        claimedFiles: [],
        channels: ['general'],
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };

      // Both agents set their status
      await redis.hset(agentA.statusKey, 'status', JSON.stringify(statusA));
      await redis.expire(agentA.statusKey, 90);

      await redis.hset(agentB.statusKey, 'status', JSON.stringify(statusB));
      await redis.expire(agentB.statusKey, 90);

      // Verify both statuses are stored
      const storedA = await redis.hget(agentA.statusKey, 'status');
      const storedB = await redis.hget(agentB.statusKey, 'status');

      expect(JSON.parse(storedA!).id).toBe(agentA.id);
      expect(JSON.parse(storedB!).id).toBe(agentB.id);
    });

    test('agents can discover each other via scan', async () => {
      const agentPattern = `opencode:${projectHash}:agent:*`;
      const agentKeys: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', agentPattern, 'COUNT', 100);
        cursor = nextCursor;
        agentKeys.push(...keys);
      } while (cursor !== '0');

      // Should find both agents
      expect(agentKeys).toHaveLength(2);
      expect(agentKeys).toContain(agentA.statusKey);
      expect(agentKeys).toContain(agentB.statusKey);
    });

    test('agents can read each others status', async () => {
      const storedA = await redis.hget(agentA.statusKey, 'status');
      const storedB = await redis.hget(agentB.statusKey, 'status');

      const statusA = JSON.parse(storedA!);
      const statusB = JSON.parse(storedB!);

      // Each agent can see the other's info
      expect(statusA.task).toBe('Implementing feature X');
      expect(statusB.task).toBe('Reviewing code');
    });
  });

  describe('Message exchange', () => {
    test('agent A can send message that agent B can read', async () => {
      const channelName = 'general';
      const historyKey = `opencode:${projectHash}:history:${channelName}`;
      const channelsKey = `opencode:${projectHash}:channels`;
      const now = Date.now();

      // Agent A sends a message
      const message = {
        id: 'msg-from-a',
        from: agentA.id,
        channel: channelName,
        type: 'info' as const,
        payload: { text: 'Hello from agent A!' },
        timestamp: new Date(now).toISOString(),
        project: projectHash,
      };

      // Store in sorted set (newest first)
      await redis.zadd(historyKey, now, JSON.stringify(message));

      // Track channel in set
      await redis.sadd(channelsKey, channelName);

      // Agent B reads the message
      const rawMessages = await redis.zrevrange(historyKey, 0, -1);
      expect(rawMessages).toHaveLength(1);

      const received = JSON.parse(rawMessages[0]);
      expect(received.from).toBe(agentA.id);
      expect(received.payload.text).toBe('Hello from agent A!');
    });

    test('agent B can send reply that agent A can read', async () => {
      const channelName = 'general';
      const historyKey = `opencode:${projectHash}:history:${channelName}`;
      const now = Date.now();

      // Agent B sends a reply
      const reply = {
        id: 'msg-from-b',
        from: agentB.id,
        channel: channelName,
        type: 'info' as const,
        payload: { text: 'Hi agent A, I got your message!' },
        timestamp: new Date(now + 100).toISOString(),
        project: projectHash,
      };

      await redis.zadd(historyKey, now + 100, JSON.stringify(reply));

      // Agent A reads all messages
      const rawMessages = await redis.zrevrange(historyKey, 0, -1);
      expect(rawMessages).toHaveLength(2);

      // Newest message should be from agent B
      const newest = JSON.parse(rawMessages[0]);
      expect(newest.from).toBe(agentB.id);
      expect(newest.payload.text).toBe('Hi agent A, I got your message!');
    });

    test('channel tracks message count', async () => {
      const channelsKey = `opencode:${projectHash}:channels`;
      const channels = await redis.smembers(channelsKey);

      expect(channels).toContain('general');
    });
  });

  describe('Claim coordination', () => {
    test('agent A can claim a file', async () => {
      const path = 'src/shared-component.ts';
      const claimKey = `opencode:${projectHash}:claim:${path}`;
      const ttlSeconds = 300;

      // Agent A claims the file
      const result = await redis.set(claimKey, JSON.stringify({
        path,
        agentId: agentA.id,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      }), 'EX', ttlSeconds, 'NX');

      expect(result).toBe('OK');

      // Agent B can see the claim exists
      const claimData = await redis.get(claimKey);
      expect(claimData).not.toBeNull();

      const claim = JSON.parse(claimData!);
      expect(claim.agentId).toBe(agentA.id);
      expect(claim.path).toBe(path);
    });

    test('agent B cannot claim file owned by agent A', async () => {
      const path = 'src/shared-component.ts';
      const claimKey = `opencode:${projectHash}:claim:${path}`;

      // Agent B tries to claim same file
      const result = await redis.set(claimKey, JSON.stringify({
        path,
        agentId: agentB.id,
        claimedAt: new Date().toISOString(),
      }), 'EX', 300, 'NX');

      // Should fail (file already claimed)
      expect(result).toBeNull();

      // Original claim still belongs to agent A
      const claimData = await redis.get(claimKey);
      expect(JSON.parse(claimData!).agentId).toBe(agentA.id);
    });

    test('agent A can release claim for agent B to use', async () => {
      const path = 'src/shared-component.ts';
      const claimKey = `opencode:${projectHash}:claim:${path}`;

      // Agent A releases
      await redis.del(claimKey);

      // Claim should be gone
      expect(await redis.get(claimKey)).toBeNull();

      // Agent B can now claim
      const result = await redis.set(claimKey, JSON.stringify({
        path,
        agentId: agentB.id,
        claimedAt: new Date().toISOString(),
      }), 'EX', 300, 'NX');

      expect(result).toBe('OK');
      expect(JSON.parse(await redis.get(claimKey)!).agentId).toBe(agentB.id);
    });
  });

  describe('Cross-channel communication', () => {
    test('agents can communicate on different channels', async () => {
      const now = Date.now();

      // Agent A sends to 'errors' channel
      const errorMsg = {
        id: 'error-1',
        from: agentA.id,
        channel: 'errors',
        type: 'error' as const,
        payload: { text: 'Something went wrong!' },
        timestamp: new Date(now).toISOString(),
        project: projectHash,
      };

      await redis.zadd(`opencode:${projectHash}:history:errors`, now, JSON.stringify(errorMsg));
      await redis.sadd(`opencode:${projectHash}:channels`, 'errors');

      // Agent B can read from errors
      const raw = await redis.zrevrange(`opencode:${projectHash}:history:errors`, 0, -1);
      expect(raw).toHaveLength(1);
      expect(JSON.parse(raw[0]).payload.text).toBe('Something went wrong!');
    });
  });

  describe('Real-time pub/sub', () => {
    test('agent receives pub/sub notification', async () => {
      const channel = `opencode:${projectHash}:ch:realtime`;
      const received: string[] = [];

      // Create a separate subscriber client (required by ioredis)
      const subscriber = createTestRedisClient();
      await subscriber.connect();

      // Agent B subscribes
      await subscriber.subscribe(channel);
      subscriber.on('message', (ch, msg) => {
        if (ch === channel) {
          received.push(msg);
        }
      });

      // Give subscription time
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Agent A publishes
      const msg = {
        id: 'realtime-1',
        from: agentA.id,
        channel: 'realtime',
        type: 'coordination' as const,
        payload: { text: 'Real-time coordination message' },
        timestamp: new Date().toISOString(),
        project: projectHash,
      };

      await redis.publish(channel, JSON.stringify(msg));

      // Agent B should receive
      const gotMessage = await waitFor(async () => received.length > 0, 2000);
      expect(gotMessage).toBe(true);
      expect(JSON.parse(received[0]).id).toBe('realtime-1');

      // Cleanup subscriber
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    });
  });
});

describe('Two-Phase Commit Simulation', () => {
  const ctx = createTestContext();
  let redis: ReturnType<typeof createTestContext>['redis'];
  let projectHash: string;

  beforeAll(async () => {
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Please start Redis server on localhost:6379');
    }
    await ctx.setup();
    redis = ctx.redis;
    projectHash = generateTestProjectHash();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  test('simulates two-phase commit for file editing', async () => {
    const path = 'src/important.ts';
    const coordinatorAgent = generateTestAgentId('coordinator');
    const participantAgent = generateTestAgentId('participant');
    const claimKey = `opencode:${projectHash}:claim:${path}`;
    const coordChannel = `opencode:${projectHash}:history:coordination`;

    // Phase 1: Coordinator sends PREPARE
    const prepareMsg = {
      id: 'prepare-1',
      from: coordinatorAgent,
      channel: 'coordination',
      type: 'coordination' as const,
      payload: {
        text: `PREPARE: Requesting lock for ${path}`,
        action: 'prepare',
        path,
      },
      timestamp: new Date().toISOString(),
      project: projectHash,
    };
    await redis.zadd(coordChannel, Date.now(), JSON.stringify(prepareMsg));

    // Participant votes YES
    const yesMsg = {
      id: 'vote-1',
      from: participantAgent,
      channel: 'coordination',
      type: 'coordination' as const,
      payload: {
        text: 'VOTE: Yes, I agree',
        action: 'vote',
        vote: 'yes',
      },
      timestamp: new Date(Date.now() + 100).toISOString(),
      project: projectHash,
    };
    await redis.zadd(coordChannel, Date.now() + 100, JSON.stringify(yesMsg));

    // Coordinator commits - acquires claim
    const result = await redis.set(claimKey, JSON.stringify({
      path,
      agentId: coordinatorAgent,
      claimedAt: new Date().toISOString(),
    }), 'EX', 300, 'NX');

    expect(result).toBe('OK');

    // Coordinator sends COMMIT
    const commitMsg = {
      id: 'commit-1',
      from: coordinatorAgent,
      channel: 'coordination',
      type: 'coordination' as const,
      payload: {
        text: `COMMIT: Lock acquired for ${path}`,
        action: 'commit',
        path,
      },
      timestamp: new Date(Date.now() + 200).toISOString(),
      project: projectHash,
    };
    await redis.zadd(coordChannel, Date.now() + 200, JSON.stringify(commitMsg));

    // Verify: all coordination messages in history
    const history = await redis.zrange(coordChannel, 0, -1);
    expect(history).toHaveLength(3);

    // Verify: claim is held by coordinator
    const claim = JSON.parse(await redis.get(claimKey)!);
    expect(claim.agentId).toBe(coordinatorAgent);
  });
});
