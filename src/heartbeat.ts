/**
 * Heartbeat timer management for AgentSyncLayer
 *
 * Manages automatic status refresh to keep agent status alive in Redis.
 * Uses 30-second intervals with 90-second TTL to ensure agents are considered
 * active even if one heartbeat is missed.
 *
 * Features:
 * - setInterval-based 30s refresh cycle
 * - 90s TTL on status keys (allows for one missed heartbeat)
 * - Tracks current status state (task, files, channels, claims)
 * - Graceful handling of disconnection
 */

import { getRedisClient } from './redis';
import type { AgentStatus } from './types';

/**
 * Heartbeat configuration constants
 */
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const STATUS_TTL_SECONDS = 90; // 90 seconds TTL

/**
 * Current agent status state tracked for heartbeat updates
 */
export interface HeartbeatState {
  /** Agent ID */
  agentId: string;
  /** Project hash for Redis key construction */
  projectHash: string;
  /** Current task description */
  task: string;
  /** Files currently being worked on */
  files: string[];
  /** Files claimed by this agent */
  claimedFiles: string[];
  /** Channels this agent is listening to */
  channels: string[];
  /** Session start time */
  startedAt: string;
}

/**
 * Heartbeat manager class
 *
 * Manages automatic status refresh for agent presence in Redis.
 * Callers should:
 * 1. Create instance with initial state
 * 2. Call start() to begin heartbeat cycle
 * 3. Call updateState() to change tracked status
 * 4. Call stop() during cleanup
 *
 * Usage:
 *   const heartbeat = new HeartbeatManager({
 *     agentId: 'devbox-1234-abcd',
 *     projectHash: 'a1b2c3d4e5f6',
 *     task: 'Implementing feature X',
 *     files: ['src/a.ts', 'src/b.ts'],
 *     claimedFiles: [],
 *     channels: ['general'],
 *     startedAt: new Date().toISOString(),
 *   });
 *
 *   heartbeat.start();
 *   // Later: heartbeat.updateState({ task: 'New task' });
 *   // Cleanup: heartbeat.stop();
 */
export class HeartbeatManager {
  private state: HeartbeatState;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  /**
   * Create a new heartbeat manager
   *
   * @param state - Initial agent state
   */
  constructor(state: HeartbeatState) {
    this.state = { ...state };
  }

  /**
   * Update the tracked heartbeat state
   *
   * Call this when the agent's status changes (new task, files, claims, etc.)
   * The next heartbeat will use the updated state.
   *
   * @param updates - Partial state to merge
   */
  updateState(updates: Partial<Omit<HeartbeatState, 'agentId' | 'projectHash'>>): void {
    this.state = { ...this.state, ...updates };
  }

  /**
   * Get the current heartbeat state
   *
   * @returns Current state snapshot
   */
  getState(): Readonly<HeartbeatState> {
    return { ...this.state };
  }

  /**
   * Check if heartbeat is currently running
   *
   * @returns True if heartbeat interval is active
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Start the heartbeat timer
   *
   * Begins automatic status refresh every 30 seconds.
   * Also performs an immediate update on start.
   *
   * If already running, this is a no-op.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Perform immediate update
    await this.updateStatus();

    // Set up interval
    this.intervalId = setInterval(() => {
      this.updateStatus().catch((error) => {
        console.warn('[HeartbeatManager] Failed to update status:', error);
      });
    }, HEARTBEAT_INTERVAL_MS);

    this.isRunning = true;
  }

  /**
   * Stop the heartbeat timer
   *
   * Clears the interval. Call this during session cleanup.
   *
   * If not running, this is a no-op.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
  }

  /**
   * Update agent status in Redis
   *
   * Sets the agent status with TTL. This is called automatically
   * by the heartbeat interval, but can also be called manually.
   *
   * @returns True if update succeeded, false if Redis unavailable
   */
  async updateStatus(): Promise<boolean> {
    const redis = getRedisClient();

    if (!redis.checkConnection()) {
      return false;
    }

    try {
      const client = redis.getClient();
      const agentKey = `opencode:${this.state.projectHash}:agent:${this.state.agentId}`;

      const status: AgentStatus = {
        id: this.state.agentId,
        task: this.state.task,
        files: this.state.files,
        claimedFiles: this.state.claimedFiles,
        channels: this.state.channels,
        startedAt: this.state.startedAt,
        lastHeartbeat: new Date().toISOString(),
      };

      // SET with EX option for TTL
      await client.set(agentKey, JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
      return true;
    } catch (error) {
      console.warn('[HeartbeatManager] Heartbeat update failed:', error);
      return false;
    }
  }

  /**
   * Get the Redis key for this agent's status
   *
   * @returns The Redis key string
   */
  getStatusKey(): string {
    return `opencode:${this.state.projectHash}:agent:${this.state.agentId}`;
  }

  /**
   * Get the status TTL in seconds
   *
   * @returns TTL value
   */
  getTtlSeconds(): number {
    return STATUS_TTL_SECONDS;
  }
}
