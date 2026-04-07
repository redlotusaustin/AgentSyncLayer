/**
 * bus_release tool - Release a file claim
 *
 * Operations:
 * 1. GET claim to verify ownership
 * 2. Lua script for atomic check + delete
 * 3. Auto-publish release event to "claims" channel
 */

import * as crypto from 'crypto';
import { getRedisClient } from '../redis';
import { hashProjectPath } from '../namespace';
import { validateFilePath, ValidationException } from '../validation';
import { generateAgentId } from '../agent';
import type {
  Claim,
  ToolContext,
  ToolResponse,
  ReleaseResponseData,
} from '../types';

// Shared agent ID across session (regenerated once per session)
let _sessionAgentId: string | null = null;

/**
 * Get the session agent ID, generating it once on first call
 */
function getSessionAgentId(): string {
  if (!_sessionAgentId) {
    _sessionAgentId = generateAgentId();
  }
  return _sessionAgentId;
}

/**
 * Claim event channel name for coordination events
 */
const CLAIMS_CHANNEL = 'claims';

/**
 * Publish a release event message to the claims channel
 */
async function publishReleaseEvent(
  client: import('ioredis').Redis,
  projectHash: string,
  agentId: string,
  filePath: string
): Promise<void> {
  const now = new Date().toISOString();
  const messageObj = {
    id: `evt-${crypto.randomUUID()}`,
    from: agentId,
    channel: CLAIMS_CHANNEL,
    type: 'release',
    payload: {
      text: `Released: ${filePath}`,
      path: filePath,
      agentId,
    },
    timestamp: now,
    project: projectHash,
  };

  const messageJson = JSON.stringify(messageObj);
  const pubSubChannel = `opencode:${projectHash}:ch:${CLAIMS_CHANNEL}`;
  const historyKey = `opencode:${projectHash}:history:${CLAIMS_CHANNEL}`;
  const channelsKey = `opencode:${projectHash}:channels`;
  const timestampMs = Date.now();

  const pipeline = client.pipeline();
  pipeline.publish(pubSubChannel, messageJson);
  pipeline.zadd(historyKey, timestampMs, messageJson);
  pipeline.zremrangebyrank(historyKey, 0, -501);
  pipeline.sadd(channelsKey, CLAIMS_CHANNEL);
  await pipeline.exec();
}

/**
 * Tool arguments for bus_release
 */
export interface BusReleaseArgs {
  path: string;
}

/**
 * Lua script for atomic claim release with ownership verification
 *
 * KEYS[1] = claim key
 * ARGV[1] = agent ID claiming ownership
 *
 * Returns:
 *   1 = released successfully
 *   0 = not claimed
 *  -1 = claimed by another agent
 *  -2 = key doesn't exist
 */
const RELEASE_CLAIM_SCRIPT = `
local key = KEYS[1]
local agentId = ARGV[1]

-- Check if key exists
local exists = redis.call('EXISTS', key)
if exists == 0 then
  return -2
end

-- Get current claim
local claimData = redis.call('GET', key)
if not claimData then
  return -2
end

-- Parse claim
local claim = cjson.decode(claimData)

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
    const projectHash = hashProjectPath(context.directory);
    const claimKey = `opencode:${projectHash}:claim:${filePath}`;
    const client = redis.getClient();

    // First, check if claim exists at all
    const claimData = await client.get(claimKey);

    if (!claimData) {
      return {
        ok: false,
        error: `File '${filePath}' is not claimed`,
        code: 'CLAIM_NOT_FOUND',
      };
    }

    // Parse claim to check ownership
    try {
      const claim = JSON.parse(claimData) as Claim;

      if (claim.agentId !== agentId) {
        return {
          ok: false,
          error: `File '${filePath}' is not claimed by this agent`,
          code: 'CLAIM_NOT_FOUND',
        };
      }
    } catch {
      // Malformed claim data - delete it anyway
      await client.del(claimKey);
      return {
        ok: true,
        data: {
          path: filePath,
          released: true,
        },
      };
    }

    // Use Lua script for atomic check + delete
    const result = await client.eval(
      RELEASE_CLAIM_SCRIPT,
      1,
      claimKey,
      agentId
    ) as number;

    switch (result) {
      case 1:
        // Publish release event to claims channel for coordination
        await publishReleaseEvent(client, projectHash, agentId, filePath);

        return {
          ok: true,
          data: {
            path: filePath,
            released: true,
          },
        };

      case -2:
        // Key was deleted between our check and script execution
        return {
          ok: false,
          error: `File '${filePath}' is not claimed`,
          code: 'CLAIM_NOT_FOUND',
        };

      case -1:
        // Ownership check failed
        return {
          ok: false,
          error: `File '${filePath}' is not claimed by this agent`,
          code: 'CLAIM_NOT_FOUND',
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
