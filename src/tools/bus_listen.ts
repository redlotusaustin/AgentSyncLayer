/**
 * bus_listen tool - Long-poll for new messages on channels
 *
 * Implementation: BRPOP blocking pop (v2)
 * - Uses dedicated subscriber connection for BRPOP
 * - Reads from message queue for low-latency delivery
 * - Filters out own messages (self-filter)
 * - Returns on new messages or timeout
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
 * Execute bus_listen: blocking pop for new messages on channels
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

    // Get queue key for BRPOP
    const queueKey = `opencode:${projectHash}:queue`;

    // Calculate remaining time based on timeout
    const deadline = Date.now() + timeoutSeconds * 1000;

    // Track accumulated messages across blocking calls
    const accumulatedMessages: Message[] = [];

    // Create a dedicated client for blocking operations
    // BRPOP blocks the connection, so we need a separate client
    const blockingClient = redis.createClient();

    try {
      // Blocking loop - continues until we have messages or timeout
      while (Date.now() < deadline) {
        const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));

        // BRPOP: blocking pop from queue with timeout
        // Returns [key, value] or null if timeout
        const result = await blockingClient.brpop(queueKey, remainingSeconds) as [string, string] | null;

        if (result) {
          const [, msgJson] = result;
          try {
            const msg = JSON.parse(msgJson) as Message;

            // Self-filter: exclude messages from this agent
            if (msg.from !== agentId) {
              // Channel filter: only include messages from requested channels
              if (channels.includes(msg.channel)) {
                accumulatedMessages.push(msg);
              }
            }

            // If we have accumulated messages, return immediately
            // (Don't wait for more - low latency is key)
            if (accumulatedMessages.length > 0) {
              // Sort by timestamp (newest first)
              accumulatedMessages.sort((a, b) => {
                const aTime = new Date(a.timestamp).getTime();
                const bTime = new Date(b.timestamp).getTime();
                return bTime - aTime;
              });

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
          } catch {
            // Skip malformed messages and continue
          }
        }
        // If result is null, timeout occurred - continue loop to check deadline
      }

      // Timeout reached - return accumulated messages or empty
      if (accumulatedMessages.length > 0) {
        accumulatedMessages.sort((a, b) => {
          const aTime = new Date(a.timestamp).getTime();
          const bTime = new Date(b.timestamp).getTime();
          return bTime - aTime;
        });

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
