/**
 * bus_agents tool - List active agents with their status
 *
 * Operations:
 * 1. SCAN for all agent keys
 * 2. GET each agent's status
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import type {
  AgentStatus,
  ToolContext,
  ToolResponse,
  AgentsResponseData,
} from '../types';

/** Maximum number of keys to scan per iteration */
const SCAN_BATCH_SIZE = 100;

/** Maximum total keys to scan (safety limit) */
const SCAN_MAX_KEYS = 10000;

/**
 * Execute bus_agents: list active agents with their status
 *
 * @param _args - Tool arguments (none)
 * @param context - Tool context (directory)
 * @returns Response with agent list
 */
export async function busAgentsExecute(
  _args: Record<string, never>,
  context: ToolContext
): Promise<ToolResponse<AgentsResponseData>> {
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
    // Get project hash
    const projectHash = resolveProjectHash(context.directory);
    const agentPattern = `opencode:${projectHash}:agent:*`;
    const client = redis.getClient();

    // SCAN for agent keys
    const agentKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', agentPattern, 'COUNT', SCAN_BATCH_SIZE);
      cursor = nextCursor;
      agentKeys.push(...keys);
    } while (cursor !== '0' && agentKeys.length < SCAN_MAX_KEYS); // Safety limit

    if (agentKeys.length === 0) {
      return {
        ok: true,
        data: {
          agents: [],
          count: 0,
        },
      };
    }

    // GET all agent statuses in parallel
    const statuses = await Promise.all(
      agentKeys.map(async (key) => {
        const data = await client.get(key);
        if (!data) return null;
        try {
          return JSON.parse(data) as AgentStatus;
        } catch {
          return null;
        }
      })
    );

    // Filter out nulls and stale entries (TTL auto-deletes, but double-check)
    const agents: AgentStatus[] = statuses
      .filter((status): status is AgentStatus => {
        if (!status) return false;
        // Check if heartbeat is recent (within 90s)
        const heartbeatAge = Date.now() - new Date(status.lastHeartbeat).getTime();
        return heartbeatAge < 90000; // 90 seconds
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      ok: true,
      data: {
        agents,
        count: agents.length,
      },
    };
  } catch (error) {
    console.error('[bus_agents] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
