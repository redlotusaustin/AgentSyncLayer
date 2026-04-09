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
 * Module-level storage for last check timestamp across calls.
 * Keyed by projectHash for multi-project isolation.
 * Persists within same session/process.
 */
const busListenLastCheckTime = new Map<string, number>();

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
    // Validate and normalize channels (can throw ValidationException)
    const channels = args.channels && args.channels.length > 0
      ? args.channels.map((c) => validateChannel(c))
      : ['general'];

    // Validate timeout (can throw ValidationException)
    const timeoutSeconds = validateTimeout(args.timeout ?? DEFAULT_TIMEOUT_SECONDS);

    // Use session agent ID (persists across all tool calls) for self-filtering
    const agentId = getSessionAgentId();

    // Get project hash
    const projectHash = resolveProjectHash(context.directory);

    // Redis key patterns
    const queueKey = `opencode:${projectHash}:queue`;
    const historyKeys = channels.map((ch) => `opencode:${projectHash}:history:${ch}`);

    // Track the earliest timestamp we've seen (start from now to avoid duplicates on first call)
    // Using Map keyed by projectHash to persist across calls within same session
    const now = Date.now();
    const lastCheck = busListenLastCheckTime.get(projectHash) ?? 0;
    if (!lastCheck || lastCheck < now - 60000) {
      // If no previous check or last check was > 1 minute ago, start from now
      busListenLastCheckTime.set(projectHash, now);
    }
    const lastCheckTime = busListenLastCheckTime.get(projectHash)!;

    // Calculate deadline
    const deadline = Date.now() + timeoutSeconds * 1000;

    // Track accumulated messages
    const accumulatedMessages: Message[] = [];

    // Create a dedicated client for blocking operations
    // BRPOP blocks the connection, so we need a separate client (cached per RedisClient)
    const blockingClient = redis.getBlockingClient();

    // Blocking loop - continues until we have messages or timeout
    while (Date.now() < deadline) {
      const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));

      // BRPOP: blocking pop from queue with timeout
      // This is just a wake-up signal - actual messages come from sorted set
      // Returns [key, value] or null if timeout
      const result = await blockingClient.brpop(queueKey, remainingSeconds) as [string, string] | null;

      // Update last check time whenever we wake up (whether from BRPOP or timeout)
      busListenLastCheckTime.set(projectHash, Date.now());

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

    accumulatedMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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
 * Fetch messages from sorted set history since a given timestamp
 */
async function fetchMessagesSinceTimestamp(
  redis: ReturnType<typeof getRedisClient>,
  historyKeys: string[],
  sinceTimestamp: number,
  agentId: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  const client = redis.getClient();
  const multi = client.multi();

  for (const key of historyKeys) {
    multi.zrevrangebyscore(key, '+inf', `(${sinceTimestamp}`, 'WITHSCORES');
  }

  const results = await multi.exec();
  if (!results) return messages;

  for (const [err, result] of results) {
    if (err) {
      console.warn('[bus_listen] Error fetching from history:', err);
      continue;
    }

    const items = result as string[];
    for (let i = 0; i < items.length; i += 2) {
      try {
        const msg = JSON.parse(items[i]) as Message;
        if (msg.from !== agentId) messages.push(msg);
      } catch {
        console.warn('[bus_listen] Malformed message in history:', items[i].substring(0, 100));
      }
    }
  }

  return messages;
}

/**
 * Reset the last check timestamp for a specific project (for testing)
 * Call this between test runs to prevent state leakage
 */
export function resetBusListenState(projectHash?: string): void {
  if (projectHash) {
    busListenLastCheckTime.delete(projectHash);
  } else {
    busListenLastCheckTime.clear();
  }
}