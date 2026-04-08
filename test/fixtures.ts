/**
 * Test fixtures for AgentBus tests
 *
 * Provides factory functions for creating test data with sensible defaults.
 * All test data uses realistic-looking IDs and timestamps.
 */

import type { Message, MessageType, MessagePayload } from '../src/types';

/**
 * Default values for test messages
 */
const DEFAULT_PROJECT_HASH = 'a1b2c3d4e5f6';
const DEFAULT_AGENT_ID = 'testagent-1234-abcd';

/**
 * Create a single test message with optional overrides
 *
 * @param overrides - Partial Message properties to override defaults
 * @returns A valid Message object with sensible defaults
 *
 * @example
 * const msg = createTestMessage({ channel: 'errors', type: 'error' });
 */
export function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${crypto.randomUUID()}`,
    from: DEFAULT_AGENT_ID,
    channel: 'general',
    type: 'info' as MessageType,
    payload: { text: 'Test message' } as MessagePayload,
    timestamp: new Date().toISOString(),
    project: DEFAULT_PROJECT_HASH,
    ...overrides,
  };
}

/**
 * Create multiple test messages with incrementing timestamps
 *
 * @param count - Number of messages to create
 * @param channel - Channel name (default: 'general')
 * @param baseTimestamp - Starting timestamp in ms (default: Date.now() - count * 1000)
 * @param projectHash - Project hash (default: test hash)
 * @returns Array of Message objects with sequential timestamps
 *
 * @example
 * const messages = createTestMessages(10, 'general');
 * const olderMessages = createTestMessages(5, 'errors', Date.now() - 10000);
 */
export function createTestMessages(
  count: number,
  channel = 'general',
  baseTimestamp = Date.now() - count * 1000,
  projectHash = DEFAULT_PROJECT_HASH
): Message[] {
  return Array.from({ length: count }, (_, i) => {
    const timestamp = baseTimestamp + i * 1000;
    return createTestMessage({
      id: `msg-test-${i}-${crypto.randomUUID().slice(0, 8)}`,
      channel,
      timestamp: new Date(timestamp).toISOString(),
      payload: { text: `Message ${i}: test content for search` } as MessagePayload,
      project: projectHash,
    });
  });
}

/**
 * Create a test message with searchable text content
 *
 * @param searchTerm - The term to include in the payload text
 * @param overrides - Additional overrides
 * @returns A Message with searchable text
 *
 * @example
 * const msg = createSearchableMessage('authentication');
 * // payload.text contains 'authentication'
 */
export function createSearchableMessage(
  searchTerm: string,
  overrides: Partial<Message> = {}
): Message {
  return createTestMessage({
    payload: { text: `Message about ${searchTerm} and related topics` } as MessagePayload,
    ...overrides,
  });
}

/**
 * Create messages from multiple agents
 *
 * @param agents - Array of agent IDs
 * @param messagesPerAgent - Number of messages per agent
 * @param channel - Channel name
 * @returns Array of messages from different agents
 *
 * @example
 * const messages = createMessagesFromMultipleAgents(['agent-a', 'agent-b'], 5);
 */
export function createMessagesFromMultipleAgents(
  agents: string[],
  messagesPerAgent: number,
  channel = 'general'
): Message[] {
  const allMessages: Message[] = [];
  for (const agentId of agents) {
    for (let i = 0; i < messagesPerAgent; i++) {
      allMessages.push(
        createTestMessage({
          id: `msg-${agentId}-${i}`,
          from: agentId,
          channel,
          payload: { text: `Message from ${agentId} #${i}` } as MessagePayload,
          timestamp: new Date(Date.now() + allMessages.length * 100).toISOString(),
        })
      );
    }
  }
  return allMessages;
}

/**
 * Create a test agent ID
 *
 * @param prefix - Optional prefix (default: 'testagent')
 * @param suffix - Optional unique suffix
 * @returns A formatted agent ID
 */
export function createTestAgentId(prefix = 'testagent', suffix?: string): string {
  const timestamp = Date.now().toString(36);
  const random = suffix ?? Math.random().toString(36).substring(2, 6);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create test project hash
 *
 * @returns A 12-character hex project hash
 */
export function createTestProjectHash(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp.toString(16)}${random}`.substring(0, 12);
}

/**
 * Create a test ToolContext
 *
 * @param directory - Project directory path
 * @param worktree - Optional worktree path
 * @returns A ToolContext object
 */
export function createTestToolContext(
  directory: string,
  worktree?: string
): { directory: string; worktree?: string } {
  return {
    directory,
    ...(worktree ? { worktree } : {}),
  };
}
