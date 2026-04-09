/**
 * Notification tracking for AgentSyncLayer
 *
 * Manages last-seen timestamps for agents to enable unread message notifications.
 * Uses Redis with a 24-hour TTL to track when each agent last read messages.
 *
 * The last-seen timestamp is used by the experimental.chat.system.transform hook
 * to determine which messages are "unread" for each agent.
 *
 * Architecture:
 * - Timestamps stored in Redis as `opencode:{projectHash}:lastseen:{agentId}`
 * - 24-hour TTL prevents stale entries from accumulating
 * - Silent failures (no errors) when Redis is unavailable
 */

import { getRedisClient } from '../redis';
import { getSessionAgentId } from '../session';
import type { Message } from '../types';

/** TTL for last-seen keys in seconds (24 hours) */
const LAST_SEEN_TTL_SECONDS = 86400;

/**
 * Build a last-seen timestamp Redis key.
 *
 * Constructs the full Redis key for storing an agent's last-seen timestamp.
 * Format: `opencode:{projectHash}:lastseen:{agentId}`
 *
 * @param projectHash - The 12-character project hash
 * @param agentId - The agent ID
 * @returns The full Redis key string
 *
 * @example
 * const key = buildLastSeenKey('a1b2c3d4e5f6', 'devbox-48201-a7f2');
 * // Returns: 'opencode:a1b2c3d4e5f6:lastseen:devbox-48201-a7f2'
 */
export function buildLastSeenKey(projectHash: string, agentId: string): string {
  return `opencode:${projectHash}:lastseen:${agentId}`;
}

/**
 * Get the last-seen timestamp for an agent.
 *
 * Retrieves the Unix timestamp in milliseconds when this agent last read messages.
 *
 * @param projectHash - The 12-character project hash
 * @param agentId - The agent ID
 * @returns Unix timestamp in milliseconds, or 0 if not set/Redis unavailable
 *
 * @example
 * const timestamp = await getLastSeenTimestamp('a1b2c3d4e5f6', 'devbox-48201-a7f2');
 * // Returns: 1712589000000 or 0 if never set
 */
export async function getLastSeenTimestamp(projectHash: string, agentId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis.checkConnection()) {
    return 0;
  }

  const key = buildLastSeenKey(projectHash, agentId);
  const client = redis.getClient();
  const value = await client.get(key);

  return value ? parseInt(value, 10) : 0;
}

/**
 * Update the last-seen timestamp for an agent to now.
 *
 * Sets the current timestamp in Redis with a 24-hour TTL.
 * If agentId is not provided, uses the session agent ID.
 *
 * @param projectHash - The 12-character project hash
 * @param agentId - The agent ID (optional, uses session agent ID if not provided)
 *
 * @example
 * // Update for specific agent
 * await updateLastSeenTimestamp('a1b2c3d4e5f6', 'devbox-48201-a7f2');
 *
 * // Update for session agent
 * await updateLastSeenTimestamp('a1b2c3d4e5f6');
 */
export async function updateLastSeenTimestamp(
  projectHash: string,
  agentId?: string,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis.checkConnection()) {
    return;
  }

  const id = agentId ?? getSessionAgentId();
  const key = buildLastSeenKey(projectHash, id);
  const client = redis.getClient();
  await client.set(key, Date.now().toString(), 'EX', LAST_SEEN_TTL_SECONDS);
}

/**
 * Build notification text lines for unread messages.
 *
 * Groups messages by channel and creates a compact notification summary
 * showing message count, sender names, and a preview of the latest message.
 *
 * @param unread - Array of unread messages
 * @returns Array of notification lines, or null if no unread messages
 *
 * @example
 * const lines = buildNotificationText(messages);
 * // Returns: ['[AgentSyncLayer] Unread messages:', '- general: 3 message(s) from ...', 'Use bus_read to view details.']
 */
export function buildNotificationText(unread: Message[]): string[] | null {
  if (unread.length === 0) {
    return null;
  }

  // Group by channel
  const byChannel = new Map<string, Message[]>();
  for (const msg of unread) {
    const existing = byChannel.get(msg.channel) ?? [];
    existing.push(msg);
    byChannel.set(msg.channel, existing);
  }

  // Build compact notification
  const lines: string[] = ['[AgentSyncLayer] Unread messages:'];
  for (const [channel, msgs] of byChannel) {
    const senders = [...new Set(msgs.map((m) => m.from))];
    const preview = (msgs[0].payload?.text ?? '').slice(0, 60);
    lines.push(
      `- ${channel}: ${msgs.length} message(s) from ${senders.join(', ')} — latest: "${preview}"`,
    );
  }
  lines.push('Use bus_read to view details.');

  return lines;
}
