/**
 * Session management for AgentSyncLayer
 *
 * Provides shared agent ID generation and caching across all modules.
 * The agent ID is generated once per session and reused for all operations.
 */

import { generateAgentId } from './agent';

/** Shared agent ID - generated once per session */
let _sessionAgentId: string | null = null;

/**
 * Get the session agent ID, generating it once on first call.
 * This ID is shared across all modules (index.ts, tools) for consistency.
 */
export function getSessionAgentId(): string {
  if (!_sessionAgentId) {
    _sessionAgentId = generateAgentId();
  }
  return _sessionAgentId;
}

/**
 * Set the session agent ID explicitly.
 * Useful for tests or when the agent ID is provided externally.
 */
export function setSessionAgentId(id: string): void {
  _sessionAgentId = id;
}

/**
 * Reset session agent ID (for testing only)
 */
export function resetSessionAgentId(): void {
  _sessionAgentId = null;
}
