/**
 * bus_send tool - Publish a message to an AgentBus channel
 *
 * Operations:
 * 1. Publish message to pub/sub channel
 * 2. Add message to sorted set history
 * 3. Prune history to 500 messages
 * 4. Add channel to active channels set
 */

import * as crypto from 'crypto';
import { getRedisClient } from '../redis';
import { hashProjectPath } from '../namespace';
import { validateChannel, validateMessage, validateMessageType, ValidationException } from '../validation';
import { RateLimiter } from '../rate-limiter';
import { generateAgentId } from '../agent';
import type {
  Message,
  MessagePayload,
  ToolContext,
  ToolResponse,
  SendResponseData,
  MessageType,
} from '../types';

// Rate limiter instance (shared across tool calls)
const rateLimiter = new RateLimiter();

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
  context: ToolContext
): Promise<ToolResponse<SendResponseData>> {
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
    const message = validateMessage(args.message);
    const messageType = args.type ? validateMessageType(args.type) : 'info';

    // Generate agent ID (could be cached in production)
    const agentId = generateAgentId();

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
    const projectHash = hashProjectPath(context.directory);

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

    const messageJson = JSON.stringify(messageObj);
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

    // 3. ZREMRANGEBYRANK to prune to 500 messages (keep newest 500)
    pipeline.zremrangebyrank(historyKey, 0, -501);

    // 4. SADD channel to active channels set
    const channelsKey = `opencode:${projectHash}:channels`;
    pipeline.sadd(channelsKey, channel);

    // Execute pipeline
    await pipeline.exec();

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
