/**
 * bus_listen tool - Long-poll for new messages on channels
 *
 * Implementation: BRPOP as wake-up signal + sorted set reads
 * - Uses BRPOP to block-wait for new message notifications (low latency)
 * - When BRPOP fires, fetches ALL messages from sorted set history (non-destructive)
 * - All agents see all messages (sorted set is not consumed on read)
 * - Self-filter and channel-filter applied after fetching
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import { validateChannel, validateTimeout, ValidationException } from '../validation';
import { getSessionAgentId } from '../session';
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
 * Maximum messages to return in a single call (reasonable cap for batch delivery)
 */
const MAX_MESSAGES_PER_CALL = 100;

/**
 * Execute bus_listen: blocking wait for new messages on channels
 *
 * Strategy:
 * 1. BRPOP blocks until a message notification arrives (low latency)
 * 2. When woken, use ZREVRANGEBYSCORE on sorted set history (non-destructive)
 * 3. Fetch ALL messages since last check - all agents get all messages
 * 4. Self-filter (exclude own messages) and channel-filter
 * 5. Return batch of messages or timeout
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

    // Redis key patterns
    const queueKey = `opencode:${projectHash}:queue`;
    const historyKeys = channels.map((ch) => `opencode:${projectHash}:history:${ch}`);

    // Track the earliest timestamp we've seen (start from now to avoid duplicates on first call)
    // Using module-level storage to persist across calls within same session
    const now = Date.now();
    if (!busListenLastCheckTime || busListenLastCheckTime < now - 60000) {
      // If no previous check or last check was > 1 minute ago, start from now
      busListenLastCheckTime = now;
    }
    const lastCheckTime = busListenLastCheckTime;

    // Calculate deadline
    const deadline = Date.now() + timeoutSeconds * 1000;

    // Track accumulated messages
    const accumulatedMessages: Message[] = [];

    // Create a dedicated client for blocking operations
    // BRPOP blocks the connection, so we need a separate client
    const blockingClient = redis.createClient();

    try {
      // Blocking loop - continues until we have messages or timeout
      while (Date.now() < deadline) {
        const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));

        // BRPOP: blocking pop from queue with timeout
        // This is just a wake-up signal - actual messages come from sorted set
        // Returns [key, value] or null if timeout
        const result = await blockingClient.brpop(queueKey, remainingSeconds) as [string, string] | null;

        // Update last check time whenever we wake up (whether from BRPOP or timeout)
        busListenLastCheckTime = Date.now();

        if (result) {
          // BRPOP fired - new message(s) available
          // Fetch ALL messages from sorted set history since last check (non-destructive)
          const newMessages = await fetchMessagesSinceTimestamp(
            redis,
            historyKeys,
            lastCheckTime,
            agentId,
          );

          // Add to accumulated messages
          for (const msg of newMessages) {
            if (accumulatedMessages.length < MAX_MESSAGES_PER_CALL) {
              accumulatedMessages.push(msg);
            }
          }

          // If we have messages, return immediately (low latency is key)
          if (accumulatedMessages.length > 0) {
            break;
          }
        }
        // If no messages found (empty set or only own messages), continue loop
        // BRPOP timeout or no new messages - check deadline and loop
      }

      // Sort by timestamp (newest first)
      if (accumulatedMessages.length > 0) {
        accumulatedMessages.sort((a, b) => {
          const aTime = new Date(a.timestamp).getTime();
          const bTime = new Date(b.timestamp).getTime();
          return bTime - aTime;
        });
      }

      // Return messages or timeout
      if (accumulatedMessages.length > 0) {
        return {
          ok: true,
          data: {
            messages: accumulatedMessages,
            count: accumulatedMessages.length,
            polled: false,
            timeout: false,
          },
        };
      }

      return {
        ok: true,
        data: {
          messages: [],
          count: 0,
          polled: false,
          timeout: true,
        },
      };
    } finally {
      // Always close the dedicated blocking client
      await blockingClient.quit().catch(() => {});
    }
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

/**
 * Module-level storage for last check timestamp across calls
 * Persists within same session/process
 */
let busListenLastCheckTime = 0;

/**
 * Fetch messages from sorted set history since a given timestamp
 *
 * @param redis - Redis client
 * @param historyKeys - Array of sorted set keys to query
 * @param sinceTimestamp - Fetch messages after this timestamp (ms)
 * @param agentId - Current agent ID for self-filtering
 * @param channels - Channels to include (for logging/debugging)
 * @returns Array of messages since timestamp
 */
async function fetchMessagesSinceTimestamp(
  redis: ReturnType<typeof getRedisClient>,
  historyKeys: string[],
  sinceTimestamp: number,
  agentId: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  const client = redis.getClient();

  // Use MULTI to fetch from all history keys atomically
  const multi = client.multi();

  for (const key of historyKeys) {
    // ZREVRANGEBYSCORE returns messages with score > sinceTimestamp
    // Using +inf as max to get all messages since the timestamp
    multi.zrevrangebyscore(key, '+inf', `(${sinceTimestamp}`, 'WITHSCORES');
  }

  const results = await multi.exec();

  if (!results) {
    return messages;
  }

  // Process results from all channels
  for (const [err, result] of results) {
    if (err) {
      console.warn('[bus_listen] Error fetching from history:', err);
      continue;
    }

    // Results come as alternating value/score pairs: [msg1, score1, msg2, score2, ...]
    const items = result as string[];
    for (let i = 0; i < items.length; i += 2) {
      const msgJson = items[i];
      try {
        const msg = JSON.parse(msgJson) as Message;

        // Self-filter: exclude messages from this agent
        if (msg.from === agentId) {
          continue;
        }

        messages.push(msg);
      } catch {
        // Skip malformed messages
        console.warn('[bus_listen] Malformed message in history:', msgJson.substring(0, 100));
      }
    }
  }

  return messages;
}

/**
 * Reset the last check timestamp (for testing)
 * Call this between test runs to prevent state leakage
 */
export function resetBusListenState(): void {
  busListenLastCheckTime = 0;
}
