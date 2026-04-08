/**
 * bus_read tool - Read recent messages from a channel
 *
 * Operations:
 * 1. ZREVRANGE history sorted set with limit
 * 2. ZCARD for total count
 */

import { getRedisClient } from '../redis';
import { hashProjectPath } from '../namespace';
import { validateChannel, validateLimit, ValidationException } from '../validation';
import { getSqliteClient } from '../sqlite';
import { getSessionAgentId } from '../session';
import { updateLastSeenTimestamp } from './notifications';
import type {
  Message,
  ToolContext,
  ToolResponse,
  ReadResponseData,
} from '../types';

/**
 * Tool arguments for bus_read
 */
export interface BusReadArgs {
  channel: string;
  limit?: number;
}

/**
 * Execute bus_read: read recent messages from a channel
 *
 * @param args - Tool arguments (channel, limit)
 * @param context - Tool context (directory)
 * @returns Response with messages and counts
 */
export async function busReadExecute(
  args: BusReadArgs,
  context: ToolContext
): Promise<ToolResponse<ReadResponseData>> {
  const redis = getRedisClient();

  try {
    // Validate inputs
    const channel = validateChannel(args.channel);
    const limit = validateLimit(args.limit ?? 20);

    // Get project hash and agent ID
    const projectHash = hashProjectPath(context.directory);
    const agentId = getSessionAgentId();
    const historyKey = `opencode:${projectHash}:history:${channel}`;

    // --- Phase 1: Try Redis cache (fast path) ---
    let messages: Message[] = [];
    let total = 0;

    if (redis.checkConnection()) {
      const client = redis.getClient();
      const [rangeResult, cardResult] = await Promise.all([
        client.zrevrange(historyKey, 0, limit - 1),
        client.zcard(historyKey),
      ]);

      // Parse messages, skipping malformed entries
      messages = rangeResult
        .map((msg) => {
          try {
            return JSON.parse(msg) as Message;
          } catch {
            return null;
          }
        })
        .filter((msg): msg is Message => msg !== null);

      total = cardResult;
    }

    // --- Phase 2: Fallback to SQLite if Redis empty ---
    // 
    // KNOWN LIMITATION: This fallback is triggered when Redis returns zero messages,
    // not when Redis has "stale" data. If Redis has older messages but SQLite has
    // newer ones, bus_read may return stale data. Per RFC, bus_read falls back to
    // SQLite when Redis is "empty" (0 messages), not "stale". This is an acceptable
    // trade-off given Redis serves as the fast cache and SQLite provides durability.
    const sqlite = getSqliteClient(context.directory, projectHash);
    if (messages.length === 0 && sqlite) {
      const result = sqlite.getMessages({
        projectHash,
        channel,
        limit,
        offset: 0,
      });
      messages = result.messages;
      total = result.total;
    }

    // --- Phase 3: Update last-seen timestamp ---
    await updateLastSeenTimestamp(projectHash, agentId).catch(() => {});

    // --- Phase 4: Check if either store was available ---
    // If both stores are unavailable, return BUS_UNAVAILABLE
    const redisWasAvailable = redis.checkConnection();
    const sqliteAvailable = sqlite !== null;

    if (!redisWasAvailable && !sqliteAvailable) {
      return {
        ok: false,
        error: 'Bus unavailable: both Redis and SQLite are unreachable',
        code: 'BUS_UNAVAILABLE' as const,
      };
    }

    return {
      ok: true,
      data: {
        channel,
        messages,
        count: messages.length,
        total,
      },
    };
  } catch (error) {
    if (error instanceof ValidationException) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
      };
    }

    console.error('[bus_read] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
