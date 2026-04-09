/**
 * bus_agents tool - List active agents with their status
 *
 * Operations:
 * 1. Get active agents via lifecycle helper
 * 2. Return agent list
 */

import { resolveProjectHash } from '../config';
import { getActiveAgents } from '../lifecycle';
import { getRedisClient } from '../redis';
import type { AgentsResponseData, ToolContext, ToolResponse } from '../types';

function unavailableResponse(): ToolResponse<AgentsResponseData> {
  return {
    ok: false,
    error: 'Bus unavailable: Redis connection not established',
    code: 'BUS_UNAVAILABLE',
  };
}

export async function busAgentsExecute(
  _args: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<AgentsResponseData>> {
  if (!getRedisClient().checkConnection()) {
    return unavailableResponse();
  }

  try {
    const agents = await getActiveAgents(resolveProjectHash(context.directory));
    return { ok: true, data: { agents, count: agents.length } };
  } catch (error) {
    console.error('[bus_agents] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
