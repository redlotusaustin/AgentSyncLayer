/**
 * bus_release tool - Release a file claim
 *
 * Operations:
 * 1. Lua script for atomic check + delete
 * 2. Auto-publish release event to "claims" channel
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import { validateFilePath, ValidationException } from '../validation';
import { getSessionAgentId } from '../session';
import { publishClaimEvent } from '../lifecycle';
import type {
  ToolContext,
  ToolResponse,
  ReleaseResponseData,
} from '../types';

/**
 * Tool arguments for bus_release
 */
export interface BusReleaseArgs {
  path: string;
}

/**
 * Lua script for atomic claim release with ownership verification.
 *
 * KEYS[1] = claim key
 * ARGV[1] = agent ID claiming ownership
 *
 * Returns:
 *   1 = released successfully
 *   2 = malformed claim data (deleted safely)
 *  -1 = claimed by another agent (not owner)
 *  -2 = key doesn't exist (not claimed)
 */
const RELEASE_CLAIM_SCRIPT = `
local key = KEYS[1]
local agentId = ARGV[1]

-- Get current claim
local claimData = redis.call('GET', key)
if not claimData then
  return -2
end

-- Try to parse claim
local ok, claim = pcall(cjson.decode, claimData)
if not ok then
  -- Malformed claim - delete and return success
  redis.call('DEL', key)
  return 2
end

-- Check ownership
if claim.agentId ~= agentId then
  return -1
end

-- Delete and return success
redis.call('DEL', key)
return 1
`;

/**
 * Execute bus_release: release a file claim
 *
 * @param args - Tool arguments (path)
 * @param context - Tool context (directory)
 * @returns Response with release confirmation
 */
export async function busReleaseExecute(
  args: BusReleaseArgs,
  context: ToolContext
): Promise<ToolResponse<ReleaseResponseData>> {
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
    // Validate path
    const filePath = validateFilePath(args.path);

    // Use session agent ID (persists across all tool calls)
    const agentId = getSessionAgentId();

    // Get project hash
    const projectHash = resolveProjectHash(context.directory);
    const claimKey = `opencode:${projectHash}:claim:${filePath}`;
    const client = redis.getClient();

    // Use Lua script for atomic check + delete (handles all cases: not found, not owner, malformed, success)
    const result = await client.eval(
      RELEASE_CLAIM_SCRIPT,
      1,
      claimKey,
      agentId
    ) as number;

    switch (result) {
      case 1:
      case 2:
        // 1 = released successfully, 2 = malformed claim deleted safely
        // Only publish event for legitimate releases (case 1)
        if (result === 1) {
          await publishClaimEvent(client, projectHash, agentId, filePath, 'release');
        }

        return {
          ok: true,
          data: {
            path: filePath,
            released: true,
          },
        };

      case -2:
        // Key doesn't exist (not claimed)
        return {
          ok: false,
          error: `File '${filePath}' is not claimed`,
          code: 'CLAIM_NOT_FOUND',
        };

      case -1:
        // Ownership check failed (claimed by another agent)
        return {
          ok: false,
          error: `File '${filePath}' is not claimed by this agent`,
          code: 'CLAIM_NOT_OWNER',
        };

      default:
        return {
          ok: false,
          error: `Internal error: unexpected release result ${result}`,
          code: 'INTERNAL_ERROR',
        };
    }
  } catch (error) {
    if (error instanceof ValidationException) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
      };
    }

    console.error('[bus_release] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
