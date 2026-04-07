/**
 * bus_status tool - Update this agent's status
 *
 * Operations:
 * 1. SET agent status with EX 60 (60 second TTL)
 */

import { getRedisClient } from '../redis';
import { hashProjectPath } from '../namespace';
import { getSessionAgentId } from '../session';
import type {
  AgentStatus,
  ToolContext,
  ToolResponse,
  StatusResponseData,
} from '../types';

/**
 * Tool arguments for bus_status
 */
export interface BusStatusArgs {
  task: string;
  files?: string[];
  channels?: string[];
}

/**
 * TTL for agent status in seconds (90s as per contract)
 */
const STATUS_TTL_SECONDS = 90;

/**
 * Execute bus_status: update this agent's status
 *
 * @param args - Tool arguments (task, files, channels)
 * @param context - Tool context (directory)
 * @returns Response with status confirmation
 */
export async function busStatusExecute(
  args: BusStatusArgs,
  context: ToolContext
): Promise<ToolResponse<StatusResponseData>> {
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
    // Validate task (max 256 chars as per contract)
    const task = args.task.trim();
    if (task.length === 0) {
      return {
        ok: false,
        error: 'Task description cannot be empty',
        code: 'CHANNEL_INVALID',
      };
    }
    if (task.length > 256) {
      return {
        ok: false,
        error: 'Task description too long: max 256 characters',
        code: 'CHANNEL_INVALID',
      };
    }

    // Use session agent ID
    const agentId = getSessionAgentId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STATUS_TTL_SECONDS * 1000);

    // Build status object
    const status: AgentStatus = {
      id: agentId,
      task,
      files: args.files ?? [],
      claimedFiles: [],
      channels: args.channels ?? ['general'],
      startedAt: now.toISOString(),
      lastHeartbeat: now.toISOString(),
    };

    // Get project hash
    const projectHash = hashProjectPath(context.directory);
    const agentKey = `opencode:${projectHash}:agent:${agentId}`;
    const client = redis.getClient();

    // SET with EX option for TTL
    await client.set(agentKey, JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);

    return {
      ok: true,
      data: {
        agentId,
        task: status.task,
        files: status.files,
        expiresAt: expiresAt.toISOString(),
      },
    };
  } catch (error) {
    console.error('[bus_status] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
