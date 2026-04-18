/**
 * Project namespace management for AgentSyncLayer
 *
 * Handles project path hashing and Redis key construction
 * according to the contract.md specifications.
 *
 * Project hash: First 12 characters of SHA-256 hash of canonical project path
 * Key format: opencode:{projectHash}:{type}:{identifier}
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

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
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);

  return hash;
}
