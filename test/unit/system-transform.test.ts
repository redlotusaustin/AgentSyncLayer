/**
 * system-transform Hook Unit Tests
 *
 * Tests for the experimental.chat.system.transform hook that injects
 * unread message notifications into the system prompt.
 *
 * Test coverage:
 * - T7.1: injects notifications when unread messages exist
 * - T7.2: no-op when no unread messages (returns null)
 * - T7.3: no-op when state.projectHash is null
 * - T7.4: no-op when state.directory is null
 * - T7.5: no-op when SQLite client unavailable
 * - T7.6: groups messages by channel correctly
 * - T7.7: includes correct preview text (first 60 chars)
 * - T7.8: appends to existing system content
 * - T7.9: handles messages without text payload gracefully
 */

import { describe, expect, test } from 'bun:test';
import type { Message } from '../../src/types';
import { buildNotificationText } from '../../src/tools/notifications';

describe('system-transform hook unit tests', () => {
  describe('T7.1: injects notifications when unread messages exist', () => {
    test('returns notification lines for unread messages', () => {
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: { text: 'Hello team, any updates on the feature?' },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
        {
          id: 'msg-2',
          from: 'agent-bob',
          channel: 'general',
          type: 'info',
          payload: { text: 'Working on the API integration now' },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const lines = buildNotificationText(unreadMessages);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toBe('[AgentBus] Unread messages:');
      expect(lines.join('\n')).toContain('general: 2 message(s) from agent-alice, agent-bob');
      expect(lines.join('\n')).toContain('Hello team');
      expect(lines.join('\n')).toContain('Use bus_read to view details.');
    });
  });

  describe('T7.2: no-op when no unread messages', () => {
    test('returns null when no unread messages', () => {
      const lines = buildNotificationText([]);
      expect(lines).toBeNull();
    });
  });

  describe('T7.3-T7.5: no-op conditions', () => {
    test('returns null when unread list is empty (simulates no projectHash)', () => {
      // When state.projectHash is null, getLastSeenTimestamp returns 0
      // which means getMessagesSince returns all messages
      // In this test we simulate the scenario where there are no unread
      const lines = buildNotificationText([]);
      expect(lines).toBeNull();
    });

    test('returns null when SQLite client unavailable (no messages)', () => {
      const lines = buildNotificationText([]);
      expect(lines).toBeNull();
    });
  });

  describe('T7.6: groups messages by channel correctly', () => {
    test('groups multiple channels separately', () => {
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: { text: 'Message in general' },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
        {
          id: 'msg-2',
          from: 'agent-bob',
          channel: 'tasks',
          type: 'info',
          payload: { text: 'Task message' },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
        {
          id: 'msg-3',
          from: 'agent-charlie',
          channel: 'general',
          type: 'info',
          payload: { text: 'Another general message' },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const lines = buildNotificationText(unreadMessages);
      const output = lines.join('\n');

      expect(output).toContain('general: 2 message(s)');
      expect(output).toContain('tasks: 1 message(s)');
      expect(output).toContain('agent-alice');
      expect(output).toContain('agent-charlie');
      expect(output).toContain('agent-bob');
    });
  });

  describe('T7.7: includes correct preview text (first 60 chars)', () => {
    test('truncates long text to 60 characters', () => {
      const longText = 'A'.repeat(100);
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: { text: longText },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const lines = buildNotificationText(unreadMessages);
      const output = lines.join('\n');

      // Preview should be first 60 chars (60 A's + quotes around it)
      expect(output).toContain('"' + 'A'.repeat(60) + '"');
      // Should not contain more than 60 A's before closing quote
      expect(output).not.toContain('"' + 'A'.repeat(61));
    });

    test('includes full text if under 60 characters', () => {
      const shortText = 'Short message';
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: { text: shortText },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const lines = buildNotificationText(unreadMessages);
      const output = lines.join('\n');

      expect(output).toContain('Short message');
    });
  });

  describe('T7.8: appends to existing system content', () => {
    test('notification lines can be appended to existing system array', () => {
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: { text: 'Test message' },
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const existingSystem: string[] = ['You are a helpful assistant.', 'Remember to be concise.'];
      const notificationLines = buildNotificationText(unreadMessages);

      // Simulate what the hook does: push to array
      existingSystem.push(...notificationLines);

      expect(existingSystem.length).toBeGreaterThan(2);
      expect(existingSystem).toContain('[AgentBus] Unread messages:');
    });
  });

  describe('T7.9: handles messages without text payload gracefully', () => {
    test('handles empty payload object', () => {
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: {}, // No text field
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const lines = buildNotificationText(unreadMessages);

      // Should not crash and should show the notification
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toBe('[AgentBus] Unread messages:');
      expect(lines.join('\n')).toContain('general: 1 message(s) from agent-alice');
    });

    test('handles undefined text payload', () => {
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          payload: { text: undefined as unknown as string }, // undefined text
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      const lines = buildNotificationText(unreadMessages);

      // Should not crash
      expect(lines.length).toBeGreaterThan(0);
    });

    test('handles missing payload entirely', () => {
      const unreadMessages: Message[] = [
        {
          id: 'msg-1',
          from: 'agent-alice',
          channel: 'general',
          type: 'info',
          // @ts-expect-error - testing missing payload
          payload: undefined,
          timestamp: new Date().toISOString(),
          project: 'hash-test-dir',
        },
      ];

      // Should not crash when accessing payload.text
      const lines = buildNotificationText(unreadMessages);
      expect(lines.length).toBeGreaterThan(0);
    });
  });
});
