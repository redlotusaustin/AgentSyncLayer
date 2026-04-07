/**
 * bus_claim tool - Claim a file for editing (advisory lock)
 *
 * Operations:
 * 1. SET NX with EX (atomic claim with TTL)
 * 2. Return conflict info if already claimed
 */

import { getRedisClient } from '../redis';
import { hashProjectPath } from '../namespace';
import { validateFilePath, ValidationException } from '../validation';
import { generateAgentId } from '../agent';
import type {
  Claim,
  ToolContext,
  ClaimResponseData,
  ClaimConflictData,
} from '../types';

/**
 * Tool arguments for bus_claim
 */
export interface BusClaimArgs {
  path: string;
}

/**
 * Default TTL for file claims (300 seconds / 5 minutes as per contract)
 */
const CLAIM_TTL_SECONDS = 300;

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

    // Generate agent ID
    const agentId = generateAgentId();

    // Get project hash
    const projectHash = hashProjectPath(context.directory);
    const claimKey = `opencode:${projectHash}:claim:${filePath}`;
    const client = redis.getClient();

    // Check if already claimed (to get conflict info)
    const existingClaimData = await client.get(claimKey);

    if (existingClaimData) {
      try {
        const existingClaim = JSON.parse(existingClaimData) as Claim;
        const conflictData: ClaimConflictData = {
          path: filePath,
          heldBy: existingClaim.agentId,
          claimedAt: existingClaim.claimedAt,
          expiresAt: existingClaim.expiresAt,
        };

        return {
          ok: false,
          error: `File '${filePath}' is already claimed by agent ${conflictData.heldBy} (claimed at ${conflictData.claimedAt}, expires at ${conflictData.expiresAt})`,
          code: 'CLAIM_CONFLICT',
          data: conflictData,
        };
      } catch {
        // Malformed claim data, try to overwrite
      }
    }

    // Create claim object
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_SECONDS * 1000);

    const claim: Claim = {
      agentId,
      claimedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // SET NX (only if not exists) with EX (TTL)
    // NX returns null if key exists, "OK" if set
    const result = await client.set(
      claimKey,
      JSON.stringify(claim),
      'EX',
      CLAIM_TTL_SECONDS,
      'NX'
    );

    if (result !== 'OK') {
      // Race condition: another agent claimed between our GET and SET
      // Re-fetch to get accurate conflict info
      const recheckData = await client.get(claimKey);
      if (recheckData) {
        try {
          const recheckClaim = JSON.parse(recheckData) as Claim;
          const conflictData: ClaimConflictData = {
            path: filePath,
            heldBy: recheckClaim.agentId,
            claimedAt: recheckClaim.claimedAt,
            expiresAt: recheckClaim.expiresAt,
          };

          return {
            ok: false,
            error: `File '${filePath}' is already claimed by agent ${conflictData.heldBy} (claimed at ${conflictData.claimedAt}, expires at ${conflictData.expiresAt})`,
            code: 'CLAIM_CONFLICT',
            data: conflictData,
          };
        } catch {
          // Malformed, treat as claim failed
        }
      }

      return {
        ok: false,
        error: `Failed to claim file '${filePath}': concurrent claim detected`,
        code: 'CLAIM_CONFLICT',
      };
    }

    return {
      ok: true,
      data: {
        path: filePath,
        agentId,
        claimedAt: claim.claimedAt,
        expiresAt: claim.expiresAt,
      },
    };
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
