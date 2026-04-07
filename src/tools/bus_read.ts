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

  // Check Redis connection
  if (!redis.checkConnection()) {
    return {
      ok: false,
      error: 'Bus unavailable: Redis connection not established',
      code: 'BUS_UNAVAILABLE',
    };
  }

  try {
    // Validate inputs
    const channel = validateChannel(args.channel);
    const limit = validateLimit(args.limit ?? 20);

    // Get project hash
    const projectHash = hashProjectPath(context.directory);
    const historyKey = `opencode:${projectHash}:history:${channel}`;
    const client = redis.getClient();

    // Execute ZREVRANGE and ZCARD in parallel
    const [rangeResult, cardResult] = await Promise.all([
      client.zrevrange(historyKey, 0, limit - 1),
      client.zcard(historyKey),
    ]);

    // Parse messages
    const messages: Message[] = rangeResult.map((msg) => {
      try {
        return JSON.parse(msg) as Message;
      } catch {
        // Skip malformed messages
        return null;
      }
    }).filter((msg): msg is Message => msg !== null);

    return {
      ok: true,
      data: {
        channel,
        messages,
        count: messages.length,
        total: cardResult,
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
