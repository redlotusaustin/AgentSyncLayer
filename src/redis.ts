/**
 * Redis client wrapper for AgentBus
 *
 * Manages Redis connection lifecycle with automatic reconnection,
 * connection state tracking, and environment variable configuration.
 *
 * Features:
 * - Connects to localhost:6379 by default
 * - Supports AGENTBUS_REDIS_URL environment variable override
 * - Tracks connection state via `connected` getter
 * - Provides `checkConnection()` helper for tools to verify connectivity
 * - Handles connection events (ready, error, close, reconnecting)
 */

import Redis from 'ioredis';

/**
 * Redis connection configuration
 */
export interface RedisConfig {
  /** Redis server URL (defaults to localhost:6379) */
  url?: string;
  /** Maximum retry attempts on connection failure (default: 3) */
  maxRetries?: number;
  /** Delay between retry attempts in ms (default: 1000) */
  retryDelayMs?: number;
}

/**
 * Redis connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Redis connection error class
 */
export class RedisConnectionError extends Error {
  public readonly code = 'BUS_UNAVAILABLE';
  public readonly isRedisError = true;

  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'RedisConnectionError';
  }
}

/**
 * Redis client wrapper class
 *
 * Wraps ioredis with additional connection management features:
 * - Connection state tracking via `connected` getter
 * - Connection check helper for tool execution
 * - Event-driven reconnection handling
 * - Environment variable support for URL configuration
 *
 * Usage:
 *   const redis = new RedisClient();
 *   if (redis.checkConnection()) {
 *     await redis.publish(channel, message);
 *   }
 *
 *   // Or with custom config:
 *   const redis = new RedisClient({ url: 'redis://custom:6379' });
 */
export class RedisClient {
  private readonly client: Redis;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  private _connected = false;
  private _state: ConnectionState = 'disconnected';
  private retryCount = 0;
  private connectionPromise: Promise<void> | null = null;

  /** Map of channel -> Set of callbacks (deduplicates handlers) */
  private readonly channelCallbacks = new Map<string, Set<(message: string) => void>>();

  constructor(config?: RedisConfig) {
    const redisUrl = process.env.AGENTBUS_REDIS_URL ?? config?.url ?? 'redis://localhost:6379';
    this.maxRetries = config?.maxRetries ?? 3;
    this.retryDelayMs = config?.retryDelayMs ?? 1000;

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: this.maxRetries,
      retryStrategy: (times: number) => (times > this.maxRetries ? null : this.retryDelayMs),
      enableOfflineQueue: true,
      connectTimeout: 10000,
    });

    this.setupEventHandlers();
    this.connect();
  }

  private get clientOptions() {
    return {
      maxRetriesPerRequest: this.maxRetries,
      retryStrategy: (times: number) => (times > this.maxRetries ? null : this.retryDelayMs),
      enableOfflineQueue: true,
      connectTimeout: 10000,
    };
  }

  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      this._connected = true;
      this._state = 'connected';
      this.retryCount = 0;
    });

    this.client.on('error', (err: Error) => {
      this._connected = false;
      this._state = 'disconnected';
      console.error('[Redis] Connection error:', err.message);
    });

    this.client.on('close', () => {
      this._connected = false;
      this._state = 'disconnected';
    });

    this.client.on('reconnecting', () => {
      this._state = 'reconnecting';
      this.retryCount++;
    });
  }

  private connect(): void {
    if (this.connectionPromise) return;

    this._state = 'connecting';
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      if (this.client.status === 'ready') {
        this._connected = true;
        this._state = 'connected';
        resolve();
        return;
      }

      const onError = (err: Error) => {
        this.client.off('error', onError);
        this.client.off('ready', onReady);
        reject(new RedisConnectionError(`Failed to connect to Redis: ${err.message}`, err));
      };

      const onReady = () => {
        this.client.off('error', onError);
        this.client.off('ready', onReady);
        resolve();
      };

      this.client.once('error', onError);
      this.client.once('ready', onReady);
    }).finally(() => { this.connectionPromise = null; });
  }

  get state(): ConnectionState { return this._state; }
  get connected(): boolean { return this._connected; }

  checkConnection(): boolean {
    return this._connected && this.client.status === 'ready';
  }

  async waitForConnection(timeoutMs = 5000): Promise<void> {
    if (this.checkConnection()) return;

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new RedisConnectionError(`Connection timeout after ${timeoutMs}ms`)), timeoutMs)
    );

    return Promise.race([this.connectionPromise ?? Promise.resolve(), timeout]);
  }

  async publish(channel: string, message: string): Promise<number> {
    if (!this.checkConnection()) {
      throw new RedisConnectionError('Cannot publish: Redis is not connected');
    }
    return this.client.publish(channel, message);
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.checkConnection()) {
      throw new RedisConnectionError('Cannot subscribe: Redis is not connected');
    }

    if (!this.channelCallbacks.has(channel)) {
      this.channelCallbacks.set(channel, new Set());
      await this.client.subscribe(channel);
      this.client.on('message', (ch: string, msg: string) => {
        this.channelCallbacks.get(ch)?.forEach((cb) => cb(msg));
      });
    }

    this.channelCallbacks.get(channel)!.add(callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    if (!this.checkConnection()) {
      throw new RedisConnectionError('Cannot unsubscribe: Redis is not connected');
    }
    this.channelCallbacks.delete(channel);
    await this.client.unsubscribe(channel);
  }

  getClient(): Redis { return this.client; }

  createClient(): Redis {
    return new Redis(process.env.AGENTBUS_REDIS_URL ?? 'redis://localhost:6379', this.clientOptions);
  }

  async close(): Promise<void> {
    this._connected = false;
    this._state = 'disconnected';
    await this.client.quit();
  }

  forceClose(): void {
    this._connected = false;
    this._state = 'disconnected';
    this.client.disconnect();
  }
}

/**
 * Default Redis client instance
 *
 * Created lazily on first access. Can be overridden by setting
 * a new instance directly.
 */
let defaultClient: RedisClient | null = null;

/**
 * Get the default Redis client instance
 *
 * Creates a new instance if one doesn't exist.
 * Useful for modules that need shared access to Redis.
 *
 * @param config - Optional configuration for new instance
 * @returns The default RedisClient instance
 */
export function getRedisClient(config?: RedisConfig): RedisClient {
  if (!defaultClient) {
    defaultClient = new RedisClient(config);
  }
  return defaultClient;
}

/**
 * Set the default Redis client instance
 *
   * Useful for testing or when you need to share a custom-configured client.
   *
   * @param client - The RedisClient instance to use as default
   */
export function setRedisClient(client: RedisClient): void {
  defaultClient = client;
}

/**
 * Reset the default Redis client instance
 *
   * Forces creation of a new client on next getRedisClient() call.
   * Does not close the existing client.
   */
export function resetRedisClient(): void {
  defaultClient = null;
}

