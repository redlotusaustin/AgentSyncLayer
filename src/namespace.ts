/**
 * Project namespace management for AgentBus
 *
 * Handles project path hashing and Redis key construction
 * according to the contract.md specifications.
 *
 * Project hash: First 12 characters of SHA-256 hash of canonical project path
 * Key format: opencode:{projectHash}:{type}:{identifier}
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { KeyType } from './types';

/**
 * Generate a 12-character project hash from a directory path
 *
 * Uses SHA-256 of the canonical (realpath-resolved) directory path,
 * taking the first 12 hex characters for the project namespace.
 *
 * @param directory - The project directory path
 * @returns 12-character lowercase hex project hash
 */
export function hashProjectPath(directory: string): string {
  // Resolve symlinks to canonical path
  const canonical = fs.realpathSync(directory);

  // SHA-256 hash, take first 12 hex chars (48 bits of entropy)
  const hash = crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 12);

  return hash;
}

/**
 * Build a Redis key from project hash and parts
 *
 * Key format: opencode:{projectHash}:{parts.join(":")}
 *
 * @param projectHash - The 12-character project hash
 * @param type - The key type (ch, history, agent, claim, channels)
 * @param identifier - The identifier for the key (channel name, agent ID, file path)
 * @returns The full Redis key string
 */
export function buildKey(projectHash: string, type: KeyType, identifier?: string): string {
  const prefix = `opencode:${projectHash}`;

  if (identifier !== undefined) {
    return `${prefix}:${type}:${identifier}`;
  }

  return `${prefix}:${type}`;
}

/**
 * Key builder class for cleaner API usage
 *
 * Usage:
 *   const keys = createKeyBuilder(projectHash);
 *   keys.channel("general")  -> "opencode:a1b2c3d4e5f6:ch:general"
 *   keys.history("general")    -> "opencode:a1b2c3d4e5f6:history:general"
 *   keys.agent("devbox-1234") -> "opencode:a1b2c3d4e5f6:agent:devbox-1234"
 *   keys.channels()           -> "opencode:a1b2c3d4e5f6:channels"
 */
export class KeyBuilder {
  private readonly prefix: string;

  constructor(projectHash: string) {
    if (!/^[a-f0-9]{12}$/.test(projectHash)) {
      throw new Error(`Invalid project hash: ${projectHash}. Expected 12-char lowercase hex.`);
    }
    this.prefix = `opencode:${projectHash}`;
  }

  /**
   * Build a channel pub/sub key
   * Format: opencode:{hash}:ch:{channel}
   */
  channel(channel: string): string {
    return `${this.prefix}:ch:${channel}`;
  }

  /**
   * Build a history sorted set key
   * Format: opencode:{hash}:history:{channel}
   */
  history(channel: string): string {
    return `${this.prefix}:history:${channel}`;
  }

  /**
   * Build an agent status key
   * Format: opencode:{hash}:agent:{agentId}
   */
  agent(agentId: string): string {
    return `${this.prefix}:agent:${agentId}`;
  }

  /**
   * Build a file claim key
   * Format: opencode:{hash}:claim:{filePath}
   */
  claim(filePath: string): string {
    return `${this.prefix}:claim:${filePath}`;
  }

  /**
   * Build the channels set key
   * Format: opencode:{hash}:channels
   */
  channels(): string {
    return `${this.prefix}:channels`;
  }

  /**
   * Build a last-seen timestamp key
   * Format: opencode:{hash}:lastseen:{agentId}
   */
  lastseen(agentId: string): string {
    return `${this.prefix}:lastseen:${agentId}`;
  }

  /**
   * Build a pattern for SCAN operations
   * @param type - The key type to match
   * @param suffix - Optional suffix pattern
   */
  pattern(type: KeyType, suffix?: string): string {
    if (suffix !== undefined) {
      return `${this.prefix}:${type}:${suffix}`;
    }
    return `${this.prefix}:${type}:*`;
  }
}

/**
 * Create a KeyBuilder for a given project hash
 *
 * @param projectHash - The 12-character project hash
 * @returns A KeyBuilder instance
 */
export function createKeyBuilder(projectHash: string): KeyBuilder {
  return new KeyBuilder(projectHash);
}

