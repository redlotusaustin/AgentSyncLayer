/**
 * Agent ID generation and management for AgentSyncLayer
 *
 * Generates unique agent IDs in the format: hostname-pid-random4hex
 * Example: devbox-48201-a7f2
 *
 * The random suffix ensures uniqueness even on machines with the same hostname
 * or when multiple agents start at the same second.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';

/**
 * Agent ID pattern: hostname-pid-random4hex
 * Regex: ^[a-zA-Z0-9._-]+-[0-9]+-[a-f0-9]{4}$
 *
 * - hostname: sanitized to alphanumeric, dots, underscores, hyphens (max 32 chars)
 * - pid: process ID
 * - random4: 4 hex chars from random bytes (16 bits of entropy)
 */
export interface AgentIdComponents {
  hostname: string;
  pid: number;
  randomHex: string;
}

/**
 * Generate a cryptographically random 4-character hex string
 *
 * Uses crypto.randomBytes(2) for 4 hex chars (2 bytes = 4 hex chars)
 *
 * @returns A 4-character lowercase hex string
 */
function generateRandomHex(): string {
  return crypto.randomBytes(2).toString('hex');
}

/**
 * Sanitize hostname for use in agent ID
 *
 * Replaces any non-alphanumeric characters (except dots, underscores, hyphens)
 * with hyphens, then limits to 32 characters.
 *
 * @param hostname - The raw hostname
 * @returns Sanitized hostname
 */
function sanitizeHostname(hostname: string): string {
  // Replace invalid characters with hyphens
  const sanitized = hostname.replace(/[^a-zA-Z0-9._-]/g, '-');
  // Limit to 32 characters to keep agent ID reasonable length
  return sanitized.slice(0, 32);
}

/**
 * Generate a unique agent ID
 *
 * Format: {sanitized-hostname}-{pid}-{random4hex}
 *
 * Examples:
 * - devbox-48201-a7f2
 * - macbook-pro-12345-7b3c
 * - my-laptop-98701-e4a1
 *
 * @returns A unique agent ID string
 */
export function generateAgentId(): string {
  const hostname = sanitizeHostname(os.hostname());
  const pid = process.pid;
  const randomHex = generateRandomHex();

  return `${hostname}-${pid}-${randomHex}`;
}

/**
 * Generate agent ID from components
 *
 * Useful for testing or when components are known
 *
 * @param hostname - The hostname (will be sanitized)
 * @param pid - The process ID
 * @param randomHex - 4-character hex string
 * @returns A formatted agent ID
 */
export function composeAgentId(hostname: string, pid: number, randomHex: string): string {
  return `${sanitizeHostname(hostname)}-${pid}-${randomHex.toLowerCase()}`;
}

/**
 * Parse an agent ID into its components
 *
 * @param agentId - The agent ID to parse
 * @returns The parsed components or null if invalid format
 */
export function parseAgentId(agentId: string): AgentIdComponents | null {
  // Pattern: hostname-pid-random4hex
  // hostname can contain dots, underscores, hyphens
  // Must end with -pid-random4hex
  const pattern = /^(.+)-(\d+)-([a-f0-9]{4})$/;
  const match = agentId.match(pattern);

  if (!match) {
    return null;
  }

  return {
    hostname: match[1],
    pid: parseInt(match[2], 10),
    randomHex: match[3].toLowerCase(),
  };
}
