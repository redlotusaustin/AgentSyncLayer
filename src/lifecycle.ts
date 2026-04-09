/**
 * Lifecycle helpers for AgentBus plugin
 *
 * Shared utilities for agent cleanup and coordination context retrieval.
 * These functions accept projectHash and agentId as explicit parameters
 * rather than reading from global state, making them reusable and testable.
 */

import * as crypto from 'crypto';
import { getRedisClient } from './redis';
import type { AgentStatus, Claim, Message } from './types';

/** Maximum number of keys to scan per iteration */
const SCAN_BATCH_SIZE = 100;

/** Maximum total keys to scan (safety limit to prevent runaway scans) */
const SCAN_MAX_KEYS = 10000;

/** Maximum number of messages to keep in channel history */
const HISTORY_CAP = 100;

/** Claim event channel name for coordination events */
const CLAIMS_CHANNEL = 'claims';

/**
 * Publish a claim/release event message to the claims channel.
 *
 * Used by bus_claim and bus_release to notify other agents about claim changes.
 *
 * @param client - The raw ioredis client
 * @param projectHash - The 12-character project hash
 * @param agentId - The agent ID performing the action
 * @param filePath - The file path being claimed/released
 * @param eventType - Either 'claim' or 'release'
 */
export async function publishClaimEvent(
  client: import('ioredis').Redis,
  projectHash: string,
  agentId: string,
  filePath: string,
  eventType: 'claim' | 'release'
): Promise<void> {
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
    timestamp: new Date().toISOString(),
    project: projectHash,
  };

  const messageJson = JSON.stringify(messageObj);
  const pipeline = client.pipeline();
  pipeline.publish(`opencode:${projectHash}:ch:${CLAIMS_CHANNEL}`, messageJson);
  pipeline.zadd(`opencode:${projectHash}:history:${CLAIMS_CHANNEL}`, Date.now(), messageJson);
  pipeline.zremrangebyrank(`opencode:${projectHash}:history:${CLAIMS_CHANNEL}`, 0, -(HISTORY_CAP + 1));
  pipeline.sadd(`opencode:${projectHash}:channels`, CLAIMS_CHANNEL);
  await pipeline.exec();
}

/**
 * Get all active agents from Redis for a project
 *
 * Scans for agent keys and filters to those with recent heartbeats (< 90 seconds).
 *
 * @param projectHash - The 12-character project hash
 * @returns Array of active agent statuses, sorted by last heartbeat (newest first)
 */
export async function getActiveAgents(projectHash: string): Promise<AgentStatus[]> {
  const redis = getRedisClient();
  const client = redis.getClient();
  const agentPattern = `opencode:${projectHash}:agent:*`;

  const agentKeys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', agentPattern, 'COUNT', SCAN_BATCH_SIZE);
    cursor = nextCursor;
    agentKeys.push(...keys);
  } while (cursor !== '0' && agentKeys.length < SCAN_MAX_KEYS);

  // Batch fetch all agent data in single round-trip
  const agentDataList = await client.mget(agentKeys);

  const statuses = agentDataList.map((data) => {
    if (!data) return null;
    try {
      return JSON.parse(data) as AgentStatus;
    } catch {
      return null;
    }
  });

  return statuses
    .filter((status): status is AgentStatus => {
      if (!status) return false;
      const heartbeatAge = Date.now() - new Date(status.lastHeartbeat).getTime();
      return heartbeatAge < 90_000; // 90 seconds
    })
    .sort((a, b) => new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime());
}

/**
 * Get all file claims held by a specific agent
 *
 * @param projectHash - The 12-character project hash
 * @param agentId - The agent ID to filter claims by
 * @returns Array of claims held by the specified agent
 */
export async function getMyClaims(projectHash: string, agentId: string): Promise<Claim[]> {
  const redis = getRedisClient();
  const client = redis.getClient();
  const claimPattern = `opencode:${projectHash}:claim:*`;

  const claimKeys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', claimPattern, 'COUNT', SCAN_BATCH_SIZE);
    cursor = nextCursor;
    claimKeys.push(...keys);
  } while (cursor !== '0' && claimKeys.length < SCAN_MAX_KEYS);

  const claims: Claim[] = [];
  const prefix = `opencode:${projectHash}:claim:`;

  // Batch fetch all claim data in single round-trip
  const claimDataList = await client.mget(claimKeys);

  for (let i = 0; i < claimKeys.length; i++) {
    const key = claimKeys[i];
    const data = claimDataList[i];
    if (!data) continue;
    try {
      const claim = JSON.parse(data) as Claim;
      if (claim.agentId === agentId) {
        // Extract path from key if not present in claim
        if (!claim.path && key.startsWith(prefix)) {
          claim.path = key.slice(prefix.length);
        }
        claims.push(claim);
      }
    } catch {
      // Skip malformed claims
    }
  }

  return claims;
}

/**
 * Get recent messages from specified channels
 *
 * @param projectHash - The 12-character project hash
 * @param channels - Array of channel names to fetch from
 * @param limit - Maximum messages per channel (default: 5)
 * @param agentId - Agent ID to filter out (optional, excludes messages from this agent)
 * @returns Array of messages sorted by timestamp (newest first)
 */
export async function getRecentMessages(
  projectHash: string,
  channels: string[],
  limit = 5,
  agentId?: string
): Promise<Message[]> {
  const redis = getRedisClient();
  const client = redis.getClient();

  const allMessages: Message[] = [];

  for (const channel of channels) {
    const historyKey = `opencode:${projectHash}:history:${channel}`;
    const rawMessages = await client.zrevrange(historyKey, 0, limit - 1);

    for (const raw of rawMessages) {
      try {
        const msg = JSON.parse(raw) as Message;
        // Filter out messages from this agent if agentId provided
        if (!agentId || msg.from !== agentId) {
          allMessages.push(msg);
        }
      } catch {
        // Skip malformed messages
      }
    }
  }

  return allMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/**
 * Format coordination context for session compaction
 *
 * Generates a markdown-formatted string summarizing:
 * - Active agents with their tasks
 * - Recent messages from other agents
 * - File claims held by the current agent
 *
 * @param agents - Active agent statuses
 * @param myClaims - Claims held by this agent
 * @param recentMessages - Recent messages from other agents
 * @returns Formatted markdown string for context injection
 */
export function formatCompactionContext(
  agents: AgentStatus[],
  myClaims: Claim[],
  recentMessages: Message[]
): string {
  const lines: string[] = [];
  lines.push('## AgentBus — Active Coordination State');
  lines.push('');

  if (agents.length > 0) {
    lines.push(`### Active Agents (${agents.length})`);
    for (const agent of agents) {
      lines.push(`- **${agent.id}**: ${agent.task}`);
      if (agent.files.length > 0) {
        lines.push(`  Files: ${agent.files.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (recentMessages.length > 0) {
    lines.push('### Recent Messages');
    for (const msg of recentMessages) {
      lines.push(`- [${msg.channel}] ${msg.from}: ${msg.payload.text}`);
    }
    lines.push('');
  }

  if (myClaims.length > 0) {
    lines.push('### Your File Claims');
    for (const claim of myClaims) {
      lines.push(`- ${claim.path} (expires ${claim.expiresAt})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Clean up an agent's resources from Redis
 *
 * Removes:
 * - The agent's status key
 * - All file claims held by this agent
 *
 * @param projectHash - The 12-character project hash
 * @param agentId - The agent ID to clean up
 */
export async function cleanupAgent(projectHash: string, agentId: string): Promise<void> {
  const redis = getRedisClient();
  const client = redis.getClient();

  try {
    // Delete agent status key
    const agentKey = `opencode:${projectHash}:agent:${agentId}`;
    await client.del(agentKey);

    // Release all claims held by this agent
    const claimPattern = `opencode:${projectHash}:claim:*`;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', claimPattern, 'COUNT', SCAN_BATCH_SIZE);
      cursor = nextCursor;

      for (const key of keys) {
        const data = await client.get(key);
        if (data) {
          try {
            const claim = JSON.parse(data) as Claim;
            if (claim.agentId === agentId) {
              await client.del(key);
            }
          } catch {
            // Malformed claim - delete it
            await client.del(key);
          }
        }
      }
    } while (cursor !== '0');
  } catch (error) {
    console.warn('[AgentBus] Cleanup error:', error);
  }
}
