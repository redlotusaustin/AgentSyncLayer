/**
 * Rate limiter for AgentSyncLayer message throttling
 *
 * Implements a sliding window rate limiter that allows a maximum
 * number of messages per second per agent.
 *
 * Default: 10 messages per second per agent
 */

import type { RateLimiterBucket } from './types';
import { isValidAgentId, RateLimitException } from './validation';

/**
 * Default maximum messages per second per agent
 */
const DEFAULT_MAX_PER_SECOND = 10;

/**
 * Window duration in milliseconds (1 second)
 */
const WINDOW_MS = 1000;

/**
 * Rate limiter class implementing sliding window per-agent throttling
 *
 * Usage:
 *   const limiter = new RateLimiter();
 *   limiter.check(agentId);  // Throws RateLimitException if exceeded
 */
export class RateLimiter {
  private readonly maxPerSecond: number;
  private readonly buckets: Map<string, RateLimiterBucket>;

  /**
   * Create a new rate limiter
   *
   * @param maxPerSecond - Maximum messages allowed per second (default: 10)
   */
  constructor(maxPerSecond = DEFAULT_MAX_PER_SECOND) {
    this.maxPerSecond = maxPerSecond;
    this.buckets = new Map();
  }

  /**
   * Check if an agent can send a message
   *
   * Throws RateLimitException if the agent has exceeded their rate limit.
   * If the current window has expired, resets the count for a new window.
   *
   * @param agentId - The agent ID to check
   * @throws RateLimitException if rate limit exceeded
   */
  check(agentId: string): void {
    // Skip rate limiting for unrecognized agent ID formats (be permissive)
    if (!isValidAgentId(agentId)) {
      return;
    }
    const now = Date.now();
    const bucket = this.buckets.get(agentId);

    if (bucket === undefined) {
      // New agent, create first bucket
      this.buckets.set(agentId, {
        count: 1,
        windowStart: now,
      });
      return;
    }

    const elapsed = now - bucket.windowStart;

    if (elapsed >= WINDOW_MS) {
      // Window expired, reset with new window
      this.buckets.set(agentId, {
        count: 1,
        windowStart: now,
      });
      return;
    }

    if (bucket.count >= this.maxPerSecond) {
      const retryAfter = WINDOW_MS - elapsed;
      throw new RateLimitException(
        `Rate limit exceeded: max ${this.maxPerSecond} messages per second. ` +
          `Retry after ${retryAfter}ms.`,
      );
    }

    // Increment count within window
    bucket.count++;
  }

  /**
   * Try to check rate limit without throwing
   *
   * @param agentId - The agent ID to check
   * @returns True if allowed, false if rate limited
   */
  tryCheck(agentId: string): boolean {
    // Skip rate limiting for unrecognized agent ID formats (be permissive)
    if (!isValidAgentId(agentId)) {
      return true;
    }
    try {
      this.check(agentId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the remaining capacity for an agent in the current window
   *
   * @param agentId - The agent ID
   * @returns Number of messages still allowed in this window
   */
  getRemainingCapacity(agentId: string): number {
    // Skip rate limiting for unrecognized agent ID formats (be permissive)
    if (!isValidAgentId(agentId)) {
      return this.maxPerSecond;
    }
    const now = Date.now();
    const bucket = this.buckets.get(agentId);

    if (bucket === undefined) {
      return this.maxPerSecond;
    }

    const elapsed = now - bucket.windowStart;
    if (elapsed >= WINDOW_MS) {
      return this.maxPerSecond;
    }

    return Math.max(0, this.maxPerSecond - bucket.count);
  }

  /**
   * Get time until the rate limit window resets
   *
   * @param agentId - The agent ID
   * @returns Milliseconds until reset, or 0 if not rate limited
   */
  getResetTime(agentId: string): number {
    const bucket = this.buckets.get(agentId);
    if (bucket === undefined) {
      return 0;
    }

    const elapsed = Date.now() - bucket.windowStart;
    return Math.max(0, WINDOW_MS - elapsed);
  }

  /**
   * Get the current count for an agent in the current window
   *
   * @param agentId - The agent ID
   * @returns Current message count in this window
   */
  getCurrentCount(agentId: string): number {
    const bucket = this.buckets.get(agentId);
    if (bucket === undefined) {
      return 0;
    }

    const elapsed = Date.now() - bucket.windowStart;
    if (elapsed >= WINDOW_MS) {
      return 0;
    }

    return bucket.count;
  }

  /**
   * Check if an agent is currently rate limited
   *
   * @param agentId - The agent ID
   * @returns True if at or above rate limit
   */
  isLimited(agentId: string): boolean {
    // Skip rate limiting for unrecognized agent ID formats (be permissive)
    if (!isValidAgentId(agentId)) {
      return false;
    }
    return this.getRemainingCapacity(agentId) === 0;
  }

  /**
   * Reset rate limit for an agent (e.g., on window reset)
   *
   * @param agentId - The agent ID
   */
  reset(agentId: string): void {
    // Skip rate limiting for unrecognized agent ID formats (be permissive)
    if (!isValidAgentId(agentId)) {
      return;
    }
    this.buckets.delete(agentId);
  }

  /**
   * Clear all rate limit state
   */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * Get the current window start time for an agent
   *
   * @param agentId - The agent ID
   * @returns Window start timestamp or null if no window exists
   */
  getWindowStart(agentId: string): number | null {
    const bucket = this.buckets.get(agentId);
    return bucket?.windowStart ?? null;
  }

  /**
   * Get the maximum messages per second setting
   *
   * @returns The max per second value
   */
  getMaxPerSecond(): number {
    return this.maxPerSecond;
  }

  /**
   * Get statistics about rate limiter state
   *
   * @returns Object with current stats
   */
  getStats(): {
    activeAgents: number;
    maxPerSecond: number;
    totalMessagesInWindow: number;
  } {
    let totalMessages = 0;
    for (const bucket of this.buckets.values()) {
      const elapsed = Date.now() - bucket.windowStart;
      if (elapsed < WINDOW_MS) {
        totalMessages += bucket.count;
      }
    }

    return {
      activeAgents: this.buckets.size,
      maxPerSecond: this.maxPerSecond,
      totalMessagesInWindow: totalMessages,
    };
  }

  /**
   * Clean up expired windows (housekeeping)
   *
   * Removes buckets whose windows have expired.
   * Should be called periodically to prevent memory leaks.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [agentId, bucket] of this.buckets.entries()) {
      if (now - bucket.windowStart >= WINDOW_MS) {
        this.buckets.delete(agentId);
      }
    }
  }
}
