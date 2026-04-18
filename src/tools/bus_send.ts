/**
 * bus_send tool - Publish a message to a bus channel
 *
 * Operations:
 * 1. PUBLISH message to pub/sub channel
 * 2. ZADD message to sorted set history
 * 3. ZREMRANGEBYRANK to prune history to 100 messages
 * 4. SADD channel to active channels set
 */

import * as crypto from 'node:crypto';
import { resolveDbDir, resolveProjectHash } from '../config';
import { HISTORY_CAP } from '../lifecycle';
import { RateLimiter } from '../rate-limiter';
import { getRedisClient } from '../redis';
import { getSessionAgentId } from '../session';
import { getSqliteClient } from '../sqlite';
import type {
  Message,
  MessagePayload,
  MessageType,
  SendResponseData,
  ToolContext,
  ToolResponse,
} from '../types';
import {
  ValidationException,
  validateChannel,
  validateMessage,
  validateMessageType,
} from '../validation';
import { updateLastSeenTimestamp } from './notifications';

// Rate limiter instance (shared across tool calls)
const rateLimiter = new RateLimiter();

/**
 * Clean up rate limiter state (call on session end to prevent memory leaks)
 */
export function cleanupRateLimiter(): void {
  rateLimiter.cleanup();
}

/**
 * Tool arguments for bus_send
 */
export interface BusSendArgs {
  channel: string;
  message: string;
  type?: MessageType;
}

/**
 * Execute bus_send: publish a message to a channel
 *
 * @param args - Tool arguments (channel, message, type)
 * @param context - Tool context (directory)
 * @returns Response with message ID and metadata
 */
export async function busSendExecute(
  args: BusSendArgs,
  context: ToolContext,
): Promise<ToolResponse<SendResponseData>> {
  // Guard against missing context
  if (!context?.directory) {
    return {
      ok: false,
      error: 'Context directory is required',
      code: 'INVALID_CONTEXT',
    };
  }

  try {
    // Validate inputs
    const channel = validateChannel(args.channel);
    const message = validateMessage(args.message);
    const messageType = args.type ? validateMessageType(args.type) : 'info';

    // Use session agent ID (persists across all tool calls)
    const agentId = getSessionAgentId();

    // Rate limit check
    try {
      rateLimiter.check(agentId);
    } catch (rateError) {
      if (rateError instanceof Error && 'code' in rateError && rateError.code === 'RATE_LIMITED') {
        return {
          ok: false,
          error: rateError.message,
          code: 'RATE_LIMITED',
        };
      }
      throw rateError;
    }

    // Get project hash
    const projectHash = resolveProjectHash(context.directory);

    // Generate message ID and timestamp
    const messageId = `msg-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();

    // Build message object
    const messageObj: Message = {
      id: messageId,
      from: agentId,
      channel,
      type: messageType as MessageType,
      payload: { text: message } as MessagePayload,
      timestamp,
      project: projectHash,
    };

    // --- Phase 1: Durable write to SQLite (BEFORE Redis check per RFC degradation table) ---
    let sqliteWriteSucceeded = false;
    const sqlite = getSqliteClient(resolveDbDir(context.directory), projectHash);
    if (sqlite) {
      try {
        sqlite.insertMessage(messageObj);
        // insertMessage catches errors internally and marks client unavailable.
        // Check availability to detect silent write failures.
        sqliteWriteSucceeded = sqlite.available;
      } catch (error) {
        console.warn('[bus_send] SQLite write failed, continuing with Redis only:', error);
      }
    }

    const messageJson = JSON.stringify(messageObj);
    const redis = getRedisClient();

    // Check Redis connection - if down, SQLite fallback provides durability
    if (!redis.checkConnection()) {
      if (sqliteWriteSucceeded) {
        // Redis is down but SQLite succeeded - message is durable
        return {
          ok: true,
          data: {
            id: messageId,
            channel,
            timestamp,
          },
        };
      }
      // Both failed - bus is truly unavailable
      return {
        ok: false,
        error: 'Bus unavailable: Redis connection not established',
        code: 'BUS_UNAVAILABLE',
      };
    }

    const client = redis.getClient();

    // Use pipeline for atomic operations
    const pipeline = client.pipeline();

    // 1. PUBLISH to pub/sub channel
    const pubSubChannel = `opencode:${projectHash}:ch:${channel}`;
    pipeline.publish(pubSubChannel, messageJson);

    // 2. ZADD to history sorted set (score = timestamp_ms)
    const historyKey = `opencode:${projectHash}:history:${channel}`;
    const timestampMs = Date.now();
    pipeline.zadd(historyKey, timestampMs, messageJson);

    // 3. ZREMRANGEBYRANK to prune to 100 messages (keep newest 100)
    pipeline.zremrangebyrank(historyKey, 0, -(HISTORY_CAP + 1));

    // 4. SADD channel to active channels set
    const channelsKey = `opencode:${projectHash}:channels`;
    pipeline.sadd(channelsKey, channel);

    // Execute pipeline
    const results = await pipeline.exec();
    if (results?.some(([err]) => err)) {
      const errors = results.filter(([err]) => err);
      console.warn('[bus_send] Redis pipeline had errors:', errors);
      // Redis is ephemeral (fast-path); SQLite is source of truth for durability.
      // ZADD failure at index 1 means message won't be readable via bus_history,
      // but the message is still stored in SQLite and available via bus_read.
    }

    // Also update last-seen timestamp for the sending agent
    // Non-critical: notification timestamp is best-effort; failure doesn't affect message delivery
    await updateLastSeenTimestamp(projectHash, agentId).catch(() => {});

    return {
      ok: true,
      data: {
        id: messageId,
        channel,
        timestamp,
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

    console.error('[bus_send] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
