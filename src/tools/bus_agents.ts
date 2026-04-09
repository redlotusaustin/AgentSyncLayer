/**
 * bus_agents tool - List active agents with their status
 *
 * Operations:
 * 1. Get active agents via lifecycle helper
 * 2. Return agent list
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import { getActiveAgents } from '../lifecycle';
import type {
  ToolContext,
  ToolResponse,
  AgentsResponseData,
} from '../types';

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

    // Get active agents from lifecycle helper
    const agents = await getActiveAgents(projectHash);

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
