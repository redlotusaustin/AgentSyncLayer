/**
 * bus_status tool - Update this agent's status
 *
 * Operations:
 * 1. SET agent status with EX 60 (60 second TTL)
 */

import { resolveProjectHash } from '../config';
import { getRedisClient } from '../redis';
import { getSessionAgentId } from '../session';
import { validateFilePath, validateChannel } from '../validation';
import type { AgentStatus, StatusResponseData, ToolContext, ToolResponse } from '../types';

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
  context: ToolContext,
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

  // Guard against missing context
  if (!context?.directory) {
    return {
      ok: false,
      error: 'Context directory is required',
      code: 'INVALID_CONTEXT',
    };
  }

  try {
    // Validate task (max 256 chars as per contract)
    const task = args.task?.trim() ?? '';
    if (task.length === 0) {
      return {
        ok: false,
        error: 'Task description cannot be empty',
        code: 'TASK_EMPTY',
      };
    }
    if (task.length > 256) {
      return {
        ok: false,
        error: 'Task description too long: max 256 characters',
        code: 'TASK_TOO_LONG',
      };
    }

    // Validate files array (max 50 elements, each must be a valid relative path)
    const files: string[] = [];
    if (args.files && Array.isArray(args.files)) {
      if (args.files.length > 50) {
        return {
          ok: false,
          error: 'Too many files: max 50 allowed',
          code: 'PATH_INVALID' as const,
        };
      }
      for (const file of args.files) {
        try {
          const validated = validateFilePath(file);
          if (validated.length > 256) {
            return {
              ok: false,
              error: 'File path too long: max 256 characters',
              code: 'PATH_INVALID' as const,
            };
          }
          files.push(validated);
        } catch {
          return {
            ok: false,
            error: `Invalid file path: ${String(file)}`,
            code: 'PATH_INVALID' as const,
          };
        }
      }
    }

    // Validate channels array (max 50 elements, each must be a valid channel name)
    const channels: string[] = [];
    if (args.channels && Array.isArray(args.channels)) {
      if (args.channels.length > 50) {
        return {
          ok: false,
          error: 'Too many channels: max 50 allowed',
          code: 'CHANNEL_INVALID' as const,
        };
      }
      for (const ch of args.channels) {
        try {
          channels.push(validateChannel(ch));
        } catch {
          return {
            ok: false,
            error: `Invalid channel name: ${String(ch)}`,
            code: 'CHANNEL_INVALID' as const,
          };
        }
      }
    }

    // Use session agent ID
    const agentId = getSessionAgentId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STATUS_TTL_SECONDS * 1000);

    // Build status object
    const status: AgentStatus = {
      id: agentId,
      task,
      files,
      claimedFiles: [],
      channels: channels.length > 0 ? channels : ['general'],
      startedAt: now.toISOString(),
      lastHeartbeat: now.toISOString(),
    };

    // Get project hash
    const projectHash = resolveProjectHash(context.directory);
    const agentKey = `opencode:${projectHash}:agent:${agentId}`;
    const client = redis.getClient();

    // SET with EX option for TTL
    await client.set(agentKey, JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);

    // PUBLISH status update to __status__ channel so monitors can tail it
    const pubSubChannel = `opencode:${projectHash}:ch:__status__`;
    const statusMessage = JSON.stringify({
      id: `status-${Date.now()}`,
      from: agentId,
      channel: '__status__',
      type: 'status',
      payload: { text: task, files: status.files, channels: status.channels },
      timestamp: now.toISOString(),
      project: projectHash,
    });
    // Non-critical: status publish is best-effort; failure doesn't affect status storage
    await client.publish(pubSubChannel, statusMessage).catch(() => {});

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
