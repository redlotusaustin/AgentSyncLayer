/**
 * bus_claim tool - Claim a file for editing (advisory lock)
 *
 * Operations:
 * 1. SET NX with EX (atomic claim with TTL)
 * 2. Auto-publish claim event to "claims" channel
 * 3. Return conflict info if already claimed
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import { validateFilePath, ValidationException } from '../validation';
import { getSessionAgentId } from '../session';
import { publishClaimEvent } from '../lifecycle';
import type {
  Claim,
  ToolContext,
  ClaimResponseData,
  ClaimConflictData,
} from '../types';

/**
 * Default TTL for file claims (300 seconds / 5 minutes as per contract)
 */
const CLAIM_TTL_SECONDS = 300;

/**
 * Build a success response for claim acquisition.
 */
function buildClaimSuccessResponse(
  filePath: string,
  agentId: string,
  claimedAt: string,
  expiresAt: string
): { ok: true; data: ClaimResponseData } {
  return {
    ok: true,
    data: {
      path: filePath,
      agentId,
      claimedAt,
      expiresAt,
    },
  };
}

/**
 * Build a conflict response for failed claim acquisition.
 */
function buildClaimConflictResponse(
  filePath: string,
  conflictClaim: Claim | null,
  isRetry: boolean
): { ok: false; error: string; code: 'CLAIM_CONFLICT'; data: ClaimConflictData } {
  const conflictData: ClaimConflictData = conflictClaim
    ? {
        path: filePath,
        heldBy: conflictClaim.agentId,
        claimedAt: conflictClaim.claimedAt,
        expiresAt: conflictClaim.expiresAt,
      }
    : {
        path: filePath,
        heldBy: 'unknown',
        claimedAt: 'unknown',
        expiresAt: 'unknown',
      };

  return {
    ok: false,
    error: conflictClaim
      ? `File '${filePath}' is already claimed by agent ${conflictClaim.agentId}${isRetry ? '' : ` (claimed at ${conflictClaim.claimedAt}, expires at ${conflictClaim.expiresAt})`}`
      : `Failed to claim file '${filePath}': concurrent access detected`,
    code: 'CLAIM_CONFLICT',
    data: conflictData,
  };
}

/**
 * Lua script for atomic claim acquisition with conflict detection.
 *
 * KEYS[1] = claim key (opencode:${projectHash}:claim:${filePath})
 * ARGV[1] = agent ID
 * ARGV[2] = claim JSON data
 * ARGV[3] = TTL in seconds
 *
 * Returns:
 *   { ok: 1, conflict: null } - Claim acquired
 *   { ok: 0, conflict: { ... } } - Claim conflict with holder info
 *   { ok: -1, conflict: null } - Malformed existing claim (safe to overwrite)
 */
const CLAIM_SCRIPT = `
local key = KEYS[1]
local agentId = ARGV[1]
local claimData = ARGV[2]
local ttl = tonumber(ARGV[3])

-- Try to set with NX (only if not exists)
local result = redis.call('SET', key, claimData, 'EX', ttl, 'NX')

if result == 'OK' then
  -- Successfully claimed
  return {1, nil}
end

-- Key exists - check if it's us or another agent
local existingData = redis.call('GET', key)
if not existingData then
  -- Race: key was deleted between SET NX and GET - try again
  return {-1, nil}
end

-- Try to parse existing claim
local existing = cjson.decode(existingData)

-- If we already own it, return success (idempotent)
if existing.agentId == agentId then
  -- Refresh TTL
  redis.call('EXPIRE', key, ttl)
  return {1, nil}
end

-- Conflict - return holder info
return {0, existing}
`;

/**
 * Arguments for bus_claim tool
 */
export interface BusClaimArgs {
  path: string;
}

/**
 * Execute bus_claim: claim a file for editing
 *
 * @param args - Tool arguments (path)
 * @param context - Tool context (directory)
 * @returns Response with claim confirmation or conflict info
 */
export async function busClaimExecute(
  args: BusClaimArgs,
  context: ToolContext
): Promise<
  | { ok: true; data: ClaimResponseData }
  | { ok: false; error: string; code: 'CLAIM_CONFLICT'; data: ClaimConflictData }
  | { ok: false; error: string; code: 'BUS_UNAVAILABLE' | 'PATH_INVALID' | 'CLAIM_CONFLICT' | 'INTERNAL_ERROR' }
> {
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

    // Create claim object
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_SECONDS * 1000);

    const claim: Claim = {
      path: filePath,
      agentId,
      claimedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // Use Lua script for atomic check-and-set (fixes TOCTOU race condition)
    const scriptResult = await client.eval(
      CLAIM_SCRIPT,
      1,
      claimKey,
      agentId,
      JSON.stringify(claim),
      CLAIM_TTL_SECONDS
    ) as [number, Claim | null];

    const [ok, conflictClaim] = scriptResult;

    if (ok === 1) {
      // Claim acquired (or refreshed if we already owned it)
      // Publish claim event to claims channel for coordination
      await publishClaimEvent(client, projectHash, agentId, filePath, 'claim');

      return buildClaimSuccessResponse(filePath, agentId, claim.claimedAt, claim.expiresAt);
    }

    // Conflict - another agent holds the claim
    if (conflictClaim) {
      return {
        ok: false,
        error: `File '${filePath}' is already claimed by agent ${conflictClaim.agentId} (claimed at ${conflictClaim.claimedAt}, expires at ${conflictClaim.expiresAt})`,
        code: 'CLAIM_CONFLICT',
        data: {
          path: filePath,
          heldBy: conflictClaim.agentId,
          claimedAt: conflictClaim.claimedAt,
          expiresAt: conflictClaim.expiresAt,
        },
      };
    }

    // Race condition during script execution - retry once
    const retryResult = await client.eval(
      CLAIM_SCRIPT,
      1,
      claimKey,
      agentId,
      JSON.stringify(claim),
      CLAIM_TTL_SECONDS
    ) as [number, Claim | null];

    const [retryOk, retryConflict] = retryResult;

    if (retryOk === 1) {
      await publishClaimEvent(client, projectHash, agentId, filePath, 'claim');
      return buildClaimSuccessResponse(filePath, agentId, claim.claimedAt, claim.expiresAt);
    }

    // Give up after retry - use helper to build conflict response
    return buildClaimConflictResponse(filePath, retryConflict, true);
  } catch (error) {
    if (error instanceof ValidationException) {
      const code = error.code;
      // Only PATH_INVALID is valid from validation in this tool
      if (code === 'PATH_INVALID') {
        return {
          ok: false,
          error: error.message,
          code,
        };
      }
      // For any other validation error, treat as internal
      return {
        ok: false,
        error: error.message,
        code: 'INTERNAL_ERROR' as const,
      };
    }

    console.error('[bus_claim] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
