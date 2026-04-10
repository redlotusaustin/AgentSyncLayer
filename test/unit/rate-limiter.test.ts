import { beforeEach, describe, expect, test } from 'bun:test';
import { RateLimiter } from '../../src/rate-limiter';
import { RateLimitException } from '../../src/validation';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10);
  });

  describe('basic functionality', () => {
    test('allows requests up to limit', () => {
      for (let i = 0; i < 10; i++) {
        expect(() => limiter.check('agent1')).not.toThrow();
      }
    });

    test('blocks requests over limit', () => {
      // Use 10 requests to reach limit
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      // Next request should throw
      expect(() => limiter.check('agent1')).toThrow(RateLimitException);
    });

    test('isolates agents', () => {
      // Fill up agent1's limit
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      // agent2 should still be able to send
      expect(() => limiter.check('agent2')).not.toThrow();
    });
  });

  describe('window reset', () => {
    test('resets after 1 second', async () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      expect(() => limiter.check('agent1')).toThrow(RateLimitException);

      // Wait for window to reset
      await new Promise((resolve) => setTimeout(resolve, 1050));

      // Should be allowed again
      expect(() => limiter.check('agent1')).not.toThrow();
    });
  });

  describe('tryCheck', () => {
    test('returns true when allowed', () => {
      expect(limiter.tryCheck('agent1')).toBe(true);
    });

    test('returns false when limited', () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      expect(limiter.tryCheck('agent1')).toBe(false);
    });
  });

  describe('getRemainingCapacity', () => {
    test('returns max when no requests made', () => {
      expect(limiter.getRemainingCapacity('agent1')).toBe(10);
    });

    test('decrements with each request', () => {
      limiter.check('agent1');
      expect(limiter.getRemainingCapacity('agent1')).toBe(9);
      limiter.check('agent1');
      expect(limiter.getRemainingCapacity('agent1')).toBe(8);
    });

    test('returns 0 at limit', () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      expect(limiter.getRemainingCapacity('agent1')).toBe(0);
    });

    test('returns max after window reset', async () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      expect(limiter.getRemainingCapacity('agent1')).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 1050));
      expect(limiter.getRemainingCapacity('agent1')).toBe(10);
    });
  });

  describe('getCurrentCount', () => {
    test('returns 0 for new agent', () => {
      expect(limiter.getCurrentCount('agent1')).toBe(0);
    });

    test('increments with each request', () => {
      limiter.check('agent1');
      expect(limiter.getCurrentCount('agent1')).toBe(1);
      limiter.check('agent1');
      expect(limiter.getCurrentCount('agent1')).toBe(2);
    });

    test('returns 0 after window reset', async () => {
      limiter.check('agent1');
      expect(limiter.getCurrentCount('agent1')).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1050));
      expect(limiter.getCurrentCount('agent1')).toBe(0);
    });
  });

  describe('getResetTime', () => {
    test('returns 0 for new agent', () => {
      expect(limiter.getResetTime('agent1')).toBe(0);
    });

    test('returns positive value for active agent', () => {
      limiter.check('agent1');
      const resetTime = limiter.getResetTime('agent1');
      expect(resetTime).toBeGreaterThan(0);
      expect(resetTime).toBeLessThanOrEqual(1000);
    });
  });

  describe('isLimited', () => {
    test('returns false for new agent', () => {
      expect(limiter.isLimited('agent1')).toBe(false);
    });

    test('returns false for agent under limit', () => {
      limiter.check('agent1');
      expect(limiter.isLimited('agent1')).toBe(false);
    });

    test('returns true for agent at limit', () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      expect(limiter.isLimited('agent1')).toBe(true);
    });
  });

  describe('reset', () => {
    test('resets agent to fresh state', () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('agent1');
      }
      expect(limiter.isLimited('agent1')).toBe(true);

      limiter.reset('agent1');
      expect(limiter.isLimited('agent1')).toBe(false);
      expect(limiter.getRemainingCapacity('agent1')).toBe(10);
    });
  });

  describe('clear', () => {
    test('clears all agents', () => {
      limiter.check('agent1');
      limiter.check('agent2');

      limiter.clear();

      expect(limiter.isLimited('agent1')).toBe(false);
      expect(limiter.isLimited('agent2')).toBe(false);
    });
  });

  describe('getStats', () => {
    test('returns correct stats', () => {
      limiter.check('agent1');
      limiter.check('agent1');
      limiter.check('agent2');

      const stats = limiter.getStats();
      expect(stats.activeAgents).toBe(2);
      expect(stats.maxPerSecond).toBe(10);
      expect(stats.totalMessagesInWindow).toBe(3);
    });
  });

  describe('getMaxPerSecond', () => {
    test('returns configured max', () => {
      expect(limiter.getMaxPerSecond()).toBe(10);

      const customLimiter = new RateLimiter(5);
      expect(customLimiter.getMaxPerSecond()).toBe(5);
    });
  });

  describe('getWindowStart', () => {
    test('returns null for new agent', () => {
      expect(limiter.getWindowStart('agent1')).toBeNull();
    });

    test('returns timestamp for active agent', () => {
      limiter.check('agent1');
      const windowStart = limiter.getWindowStart('agent1');
      expect(windowStart).not.toBeNull();
      expect(typeof windowStart).toBe('number');
    });
  });

  describe('cleanup', () => {
    test('removes expired windows', async () => {
      limiter.check('agent1');
      expect(limiter.getCurrentCount('agent1')).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1050));
      limiter.cleanup();

      // Agent should be gone after cleanup
      expect(limiter.getWindowStart('agent1')).toBeNull();
    });
  });
});
