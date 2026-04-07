/**
 * Agent ID generation and management for AgentBus
 *
 * Generates unique agent IDs in the format: hostname-pid-random4hex
 * Example: devbox-48201-a7f2
 *
 * The random suffix ensures uniqueness even on machines with the same hostname
 * or when multiple agents start at the same second.
 */

import * as crypto from 'crypto';
import * as os from 'os';

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

/**
 * Validate an agent ID format
 *
 * @param agentId - The agent ID to validate
 * @returns True if valid agent ID format
 */
export function isValidAgentId(agentId: string): boolean {
  const pattern = /^[a-zA-Z0-9._-]+-[0-9]+-[a-f0-9]{4}$/;
  return pattern.test(agentId);
}

/**
 * Extract the hostname portion from an agent ID
 *
 * @param agentId - The agent ID
 * @returns The hostname or null if invalid format
 */
export function extractHostname(agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  return parsed?.hostname ?? null;
}

/**
 * Extract the PID portion from an agent ID
 *
 * @param agentId - The agent ID
 * @returns The PID or null if invalid format
 */
export function extractPid(agentId: string): number | null {
  const parsed = parseAgentId(agentId);
  return parsed?.pid ?? null;
}

/**
 * Extract the random suffix from an agent ID
 *
 * @param agentId - The agent ID
 * @returns The 4-char random hex or null if invalid format
 */
export function extractRandomSuffix(agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  return parsed?.randomHex ?? null;
}

/**
 * Check if two agent IDs are from the same hostname
 *
 * @param agentId1 - First agent ID
 * @param agentId2 - Second agent ID
 * @returns True if both IDs have the same hostname
 */
export function isSameHostname(agentId1: string, agentId2: string): boolean {
  const host1 = extractHostname(agentId1);
  const host2 = extractHostname(agentId2);

  if (host1 === null || host2 === null) {
    return false;
  }

  return host1 === host2;
}

/**
 * Create a display-friendly version of agent ID for UI
 *
 * Shortens the hostname if too long
 *
 * @param agentId - The full agent ID
 * @returns A shortened display version
 */
export function shortenAgentId(agentId: string, maxLength = 20): string {
  if (agentId.length <= maxLength) {
    return agentId;
  }

  // Try to shorten hostname, keep pid-random suffix
  const parsed = parseAgentId(agentId);
  if (!parsed) {
    return agentId.slice(0, maxLength - 3) + '...';
  }

  const suffix = `-${parsed.pid}-${parsed.randomHex}`;
  const maxHostnameLen = maxLength - suffix.length - 4; // 4 for "...-"

  if (maxHostnameLen > 0) {
    const shortHostname = parsed.hostname.slice(0, maxHostnameLen);
    return `${shortHostname}...${suffix}`;
  }

  return agentId.slice(0, maxLength - 3) + '...';
}