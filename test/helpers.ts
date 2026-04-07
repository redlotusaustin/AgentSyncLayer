/**
 * Test helpers for AgentBus integration tests
 *
 * Provides Redis setup/teardown utilities using DB 15 for isolation.
 * All integration tests should use these helpers to ensure clean state.
 */

import Redis from 'ioredis';
import type { RedisClient } from '../../src/redis';

// Test Redis configuration - use DB 15 for isolation
const TEST_REDIS_URL = process.env.AGENTBUS_REDIS_URL ?? 'redis://localhost:6379';
const TEST_DB = 15;

/**
 * Parse Redis URL and add database parameter
 */
function buildTestRedisUrl(): string {
  const url = new URL(TEST_REDIS_URL);
  url.searchParams.set('db', TEST_DB.toString());
  return url.toString();
}

/**
 * Create a Redis client for testing
 */
export function createTestRedisClient(): Redis {
  const url = buildTestRedisUrl();
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    lazyConnect: true,
  });
}

/**
 * Create a RedisClient wrapper for testing
 */
export async function createTestRedisWrapper(): Promise<RedisClient> {
  const { RedisClient } = await import('../../src/redis');
  const client = new RedisClient({
    url: buildTestRedisUrl(),
    maxRetries: 3,
    retryDelayMs: 100,
  });

  // Wait for connection
  await client.waitForConnection(5000);
  return client;
}

/**
 * Clear all test data from Redis DB 15
 */
export async function clearTestDatabase(client: Redis): Promise<void> {
  // Use FLUSHDB to clear only the test database
  await client.flushdb();
}

/**
 * Test context containing Redis client and cleanup functions
 */
export interface TestContext {
  redis: Redis;
  cleanup: () => Promise<void>;
}

/**
 * Set up a fresh test context with isolated Redis connection
 *
 * Usage:
 *   describe('Redis operations', () => {
 *     const ctx = setupTestContext();
 *
 *     beforeAll(async () => {
 *       await ctx.setup();
 *     });
 *
 *     afterAll(async () => {
 *       await ctx.teardown();
 *     });
 *   });
 */
export function createTestContext(): TestContext {
  let redis: Redis | null = null;

  return {
    get redis(): Redis {
      if (!redis) {
        throw new Error('Test context not initialized. Call setup() first.');
      }
      return redis;
    },

    async setup(): Promise<void> {
      redis = createTestRedisClient();
      await redis.connect();
      // Wait for connection using ping instead of wait('ready')
      await redis.ping();
    },

    async cleanup(): Promise<void> {
      if (redis) {
        try {
          // Clear test database before closing
          await redis.flushdb();
          await redis.quit();
        } catch {
          // Ignore cleanup errors
        }
        redis = null;
      }
    },

    async teardown(): Promise<void> {
      await this.cleanup();
    },
  };
}

/**
 * Generate a unique test project hash
 */
export function generateTestProjectHash(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp.toString(16)}${random}`.substring(0, 12);
}

/**
 * Generate a unique test agent ID
 */
export function generateTestAgentId(suffix?: string): string {
  const timestamp = Date.now();
  const random = suffix ?? Math.random().toString(16).substring(2, 6);
  return `test-${timestamp}-${random}`;
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

/**
 * Check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const testClient = createTestRedisClient();
    await testClient.connect();
    await testClient.ping();
    await testClient.quit();
    return true;
  } catch {
    return false;
  }
}

/**
 * Skip tests if Redis is not available
 */
export function skipIfNoRedis(): void {
  // This is a placeholder - actual skip happens in test files
}

/**
 * Mock time passage for rate limiter tests
 */
export class MockTime {
  private originalDateNow: typeof Date.now;
  private originalSetTimeout: typeof setTimeout;
  private currentTime: number;
  private timers: Map<number, { callback: () => void; duration: number }> = new Map();
  private timerId = 0;

  constructor(startTime?: number) {
    this.currentTime = startTime ?? Date.now();
    this.originalDateNow = Date.now;
    this.originalSetTimeout = setTimeout;
  }

  start(): void {
    const self = this;
    Date.now = () => self.currentTime;
    globalThis.setTimeout = ((callback: () => void, duration?: number) => {
      const id = ++self.timerId;
      if (duration !== undefined) {
        self.timers.set(id, { callback, duration });
        // Auto-fire timer
        self.originalSetTimeout(() => {
          if (self.timers.has(id)) {
            self.timers.delete(id);
            self.currentTime += duration;
            callback();
          }
        }, 0);
      }
      return id;
    }) as typeof setTimeout;
  }

  advance(ms: number): void {
    this.currentTime += ms;
    // Fire due timers
    for (const [id, timer] of this.timers) {
      if (timer.duration <= ms) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }

  stop(): void {
    Date.now = this.originalDateNow;
    globalThis.setTimeout = this.originalSetTimeout;
    this.timers.clear();
  }

  now(): number {
    return this.currentTime;
  }
}
