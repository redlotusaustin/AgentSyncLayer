/**
 * bus-send-queue.test.ts - Integration test for T8
 *
 * Test T8: bus_send does not write to queue key
 *
 * Verifies that after busSendExecute(), no Redis key matching
 * opencode:{projectHash}:queue exists.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashProjectPath } from '../../src/namespace';
import { RedisClient, resetRedisClient, setRedisClient } from '../../src/redis';
import { resetSessionAgentId, setSessionAgentId } from '../../src/session';
import { busSendExecute, cleanupRateLimiter } from '../../src/tools/bus_send';
import type { ToolContext } from '../../src/types';
import { isRedisAvailable } from '../helpers';

// Test configuration
const TEST_REDIS_URL = process.env.AGENTSYNCLAYER_REDIS_URL ?? 'redis://localhost:6379';
const TEST_DB = 15;

function buildTestRedisUrl(): string {
  const url = new URL(TEST_REDIS_URL);
  url.searchParams.set('db', TEST_DB.toString());
  return url.toString();
}

function createTestDirectory(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-bus-send-queue-test-'));
  fs.mkdirSync(path.join(dir, '.agentsynclayer'));
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('T8: bus_send does not write to queue key', () => {
  let redisWrapper: RedisClient;
  let testDir: { dir: string; cleanup: () => void };
  let _projectHash: string;
  let testContext: ToolContext;

  beforeAll(async () => {
    // Skip if Redis is not available
    const redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      console.log('Redis not available, skipping T8 test');
      return;
    }

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
    _projectHash = hashProjectPath(testDir.dir);
    testContext = { directory: testDir.dir };
    setSessionAgentId(`test-agent-${Date.now()}`);
  });

  afterEach(async () => {
    if (redisWrapper?.checkConnection()) {
      const client = redisWrapper.getClient();
      await client.flushdb();
    }
    testDir.cleanup();
    cleanupRateLimiter();
    resetSessionAgentId();
  });

  afterAll(async () => {
    if (redisWrapper) {
      await redisWrapper.close();
    }
    resetRedisClient();
  });

  test('T8: no Redis key matching opencode:*:queue exists after busSendExecute()', async () => {
    // Skip if Redis wasn't available in beforeAll
    if (!redisWrapper) {
      return;
    }

    const client = redisWrapper.getClient();

    // Verify no queue keys exist before the test
    const keysBefore = await client.keys('opencode:*:queue');
    expect(keysBefore.length).toBe(0);

    // Send a message via bus_send
    const result = await busSendExecute(
      { channel: 'general', message: 'Test message for queue key check' },
      testContext,
    );

    // Verify the send was successful
    expect(result.ok).toBe(true);

    // Check for any queue keys after the send
    const keysAfter = await client.keys('opencode:*:queue');

    // Assert: No queue keys should exist
    expect(keysAfter).toEqual([]);
  });

  test('T8: confirms other keys exist but queue key does not', async () => {
    // Skip if Redis wasn't available in beforeAll
    if (!redisWrapper) {
      return;
    }

    const client = redisWrapper.getClient();

    // Send a message
    await busSendExecute({ channel: 'test-channel', message: 'Another test message' }, testContext);

    // Check what keys DO exist
    const allKeys = await client.keys('opencode:*');

    // Verify history keys exist (opencode:{hash}:history:{channel})
    const historyKeys = allKeys.filter((k) => k.includes(':history:'));
    expect(historyKeys.length).toBeGreaterThan(0);

    // Verify channels key exists (opencode:{hash}:channels)
    const channelsKeys = allKeys.filter((k) => k.includes(':channels'));
    expect(channelsKeys.length).toBeGreaterThan(0);

    // Verify NO queue keys exist
    const queueKeys = allKeys.filter((k) => k.includes(':queue'));
    expect(queueKeys).toEqual([]);
  });

  test('T8: sending to multiple channels still produces no queue keys', async () => {
    // Skip if Redis wasn't available in beforeAll
    if (!redisWrapper) {
      return;
    }

    const client = redisWrapper.getClient();

    // Send messages to multiple channels
    await busSendExecute({ channel: 'channel-a', message: 'Message to channel A' }, testContext);
    await busSendExecute({ channel: 'channel-b', message: 'Message to channel B' }, testContext);
    await busSendExecute({ channel: 'channel-c', message: 'Message to channel C' }, testContext);

    // Check for queue keys
    const queueKeys = await client.keys('opencode:*:queue');
    expect(queueKeys).toEqual([]);
  });
});
