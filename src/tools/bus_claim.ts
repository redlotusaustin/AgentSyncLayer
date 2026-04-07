/**
 * bus_claim tool - Claim a file for editing (advisory lock)
 *
 * Operations:
 * 1. SET NX with EX (atomic claim with TTL)
 * 2. Auto-publish claim event to "claims" channel
 * 3. Return conflict info if already claimed
 */

import * as crypto from 'crypto';
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
 * Claim event channel name for coordination events
 */
const CLAIMS_CHANNEL = 'claims';

/**
 * Publish a claim event message to the claims channel
 */
async function publishClaimEvent(
  client: import('ioredis').Redis,
  projectHash: string,
  agentId: string,
  filePath: string,
  eventType: 'claim' | 'release'
): Promise<void> {
  const now = new Date().toISOString();
  const messageObj = {
    id: `evt-${crypto.randomUUID()}`,
    from: agentId,
    channel: CLAIMS_CHANNEL,
    type: eventType,
    payload: {
      text: `${eventType === 'claim' ? 'Claimed' : 'Released'}: ${filePath}`,
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
      path: filePath,
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

    // Publish claim event to claims channel for coordination
    await publishClaimEvent(client, projectHash, agentId, filePath, 'claim');

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
