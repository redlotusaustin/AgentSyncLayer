/**
 * bus_listen tool - Long-poll for new messages on channels
 *
 * Implementation: Smart polling (v1)
 * - Records current timestamp
 * - Polls every 500ms for new messages
 * - Filters out own messages (self-filter)
 * - Returns on new messages or timeout
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import { validateChannel, validateTimeout, ValidationException } from '../validation';
import { getSessionAgentId } from '../session';
import { updateLastSeenTimestamp } from './notifications';
import type {
  Message,
  ToolContext,
  ToolResponse,
  ListenResponseData,
} from '../types';

/**
 * Tool arguments for bus_listen
 */
export interface BusListenArgs {
  channels?: string[];
  timeout?: number;
}

/**
 * Default listen timeout (10 seconds as per contract)
 */
const DEFAULT_TIMEOUT_SECONDS = 10;

/**
 * Poll interval in milliseconds
 */
const POLL_INTERVAL_MS = 500;

/**
 * Execute bus_listen: poll for new messages on channels
 *
 * @param args - Tool arguments (channels, timeout)
 * @param context - Tool context (directory)
 * @returns Response with new messages or timeout
 */
export async function busListenExecute(
  args: BusListenArgs,
  context: ToolContext
): Promise<ToolResponse<ListenResponseData>> {
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
    // Validate and normalize channels
    const channels = args.channels && args.channels.length > 0
      ? args.channels.map((c) => validateChannel(c))
      : ['general'];

    // Validate timeout
    const timeoutSeconds = validateTimeout(args.timeout ?? DEFAULT_TIMEOUT_SECONDS);

    // Use session agent ID (persists across all tool calls) for self-filtering
    const agentId = getSessionAgentId();

    // Get project hash
    const projectHash = resolveProjectHash(context.directory);
    const client = redis.getClient();

    // Record start time
    const startTime = Date.now();
    const endTime = startTime + timeoutSeconds * 1000;

    // Get latest message timestamp per channel (for filtering)
    const latestTimestamps = await Promise.all(
      channels.map(async (channel) => {
        const historyKey = `opencode:${projectHash}:history:${channel}`;
        const latest = await client.zrevrange(historyKey, 0, 0);
        const timestamp = latest.length > 0
          ? new Date(JSON.parse(latest[0]).timestamp).getTime()
          : startTime;
        return { channel, timestamp };
      })
    );

    const timestampMap = new Map<string, number>(
      latestTimestamps.map((item) => [item.channel, item.timestamp])
    );

    // Polling loop
    while (Date.now() < endTime) {
      const newMessages: Message[] = [];

      // Check each channel for new messages
      for (const channel of channels) {
        const historyKey = `opencode:${projectHash}:history:${channel}`;
        const sinceTimestamp = timestampMap.get(channel) ?? startTime;

        // Get messages with timestamp > sinceTimestamp
        // ZREVRANGEBYSCORE with exclusive min
        const messages = await client.zrevrangebyscore(
          historyKey,
          `(${sinceTimestamp}`,
          '+inf'
        );

        // Parse and filter messages
        for (const msgJson of messages) {
          try {
            const msg = JSON.parse(msgJson) as Message;
            // Self-filter: exclude messages from this agent
            if (msg.from !== agentId) {
              // Update timestamp for this channel
              const msgTimestamp = new Date(msg.timestamp).getTime();
              if (msgTimestamp > (timestampMap.get(channel) ?? 0)) {
                timestampMap.set(channel, msgTimestamp);
              }
              newMessages.push(msg);
            }
          } catch {
            // Skip malformed messages
          }
        }
      }

      if (newMessages.length > 0) {
        // Sort by timestamp (newest first) - use cached timestamp for efficiency
        newMessages.sort((a, b) => {
          const aTime = new Date(a.timestamp).getTime();
          const bTime = new Date(b.timestamp).getTime();
          return bTime - aTime;
        });
        // Mark messages as seen so they do not reappear as unread
        // Non-critical: notification timestamp is best-effort; failure doesn't affect message delivery
        await updateLastSeenTimestamp(projectHash, agentId).catch(() => {});

        return {
          ok: true,
          data: {
            messages: newMessages,
            count: newMessages.length,
            polled: true,
            timeout: false,
          },
        };
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Timeout reached - return empty response
    return {
      ok: true,
      data: {
        messages: [],
        count: 0,
        polled: true,
        timeout: true,
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

    console.error('[bus_listen] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
