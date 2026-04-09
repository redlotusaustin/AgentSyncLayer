/**
 * Heartbeat Manager Unit Tests
 *
 * Tests the HeartbeatManager class which manages automatic status refresh
 * to keep agent status alive in Redis.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { HeartbeatManager, type HeartbeatState } from '../../src/heartbeat';

// Test state factory
function createTestState(overrides: Partial<HeartbeatState> = {}): HeartbeatState {
  return {
    agentId: 'test-agent-1234-abcd',
    projectHash: 'a1b2c3d4e5f6',
    task: 'Initializing',
    files: ['src/test.ts'],
    claimedFiles: [],
    channels: ['general'],
    startedAt: '2026-04-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('HeartbeatManager', () => {
  const mockState = createTestState();

  beforeEach(() => {
    // Reset any module-level state
  });

  describe('constructor', () => {
    test('creates instance with initial state', () => {
      const manager = new HeartbeatManager(mockState);

      expect(manager.isActive()).toBe(false);
      const state = manager.getState();
      expect(state.agentId).toBe(mockState.agentId);
      expect(state.projectHash).toBe(mockState.projectHash);
      expect(state.task).toBe(mockState.task);
    });

    test('creates copy of state (immutability)', () => {
      const manager = new HeartbeatManager(mockState);
      const state = manager.getState();

      // Modifying returned state should not affect manager internal state
      expect(() => {
        (state as HeartbeatState).task = 'Modified';
      }).not.toThrow();
      expect(manager.getState().task).toBe('Initializing');
    });
  });

  describe('updateState', () => {
    test('updates partial state fields', () => {
      const manager = new HeartbeatManager(mockState);

      manager.updateState({ task: 'New task', files: ['new.ts'] });

      const state = manager.getState();
      expect(state.task).toBe('New task');
      expect(state.files).toEqual(['new.ts']);
      expect(state.agentId).toBe(mockState.agentId); // Unchanged
      expect(state.projectHash).toBe(mockState.projectHash); // Unchanged
    });

    test('preserves existing fields when updating some', () => {
      const manager = new HeartbeatManager(mockState);

      manager.updateState({ task: 'Updated' });

      const state = manager.getState();
      expect(state.task).toBe('Updated');
      expect(state.files).toEqual(mockState.files); // Preserved
      expect(state.channels).toEqual(mockState.channels); // Preserved
    });
  });

  describe('isActive', () => {
    test('returns false initially', () => {
      const manager = new HeartbeatManager(mockState);
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('getStatusKey', () => {
    test('returns correct Redis key format', () => {
      const manager = new HeartbeatManager(mockState);

      const key = manager.getStatusKey();

      expect(key).toBe(`opencode:${mockState.projectHash}:agent:${mockState.agentId}`);
    });
  });

  describe('getTtlSeconds', () => {
    test('returns configured TTL of 90 seconds', () => {
      const manager = new HeartbeatManager(mockState);

      expect(manager.getTtlSeconds()).toBe(90);
    });
  });

  describe('start and stop lifecycle', () => {
    test('stop is safe when not running', () => {
      const manager = new HeartbeatManager(mockState);

      expect(() => manager.stop()).not.toThrow();
      expect(manager.isActive()).toBe(false);
    });
  });
});

describe('Heartbeat configuration constants', () => {
  test('TTL is 90 seconds as per spec', () => {
    const manager = new HeartbeatManager(createTestState());
    expect(manager.getTtlSeconds()).toBe(90);
  });
});
