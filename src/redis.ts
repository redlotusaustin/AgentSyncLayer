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

  /**
   * Create a new Redis client wrapper
   *
   * @param config - Optional Redis configuration
   *                 If AGENTBUS_REDIS_URL is set, it will be used instead of defaults
   */
  constructor(config?: RedisConfig) {
    // Determine URL: AGENTBUS_REDIS_URL env var > config.url > default localhost:6379
    const redisUrl = process.env.AGENTBUS_REDIS_URL ?? config?.url ?? 'redis://localhost:6379';

    this.maxRetries = config?.maxRetries ?? 3;
    this.retryDelayMs = config?.retryDelayMs ?? 1000;

    // Create ioredis client with configuration
    this.client = new Redis(redisUrl, {
      // Automatic reconnection enabled by default in ioredis
      maxRetriesPerRequest: this.maxRetries,
      retryStrategy: (times: number) => {
        if (times > this.maxRetries) {
          return null; // Stop retrying
        }
        return this.retryDelayMs;
      },
      // Enable offline queue so commands queued while disconnected
      // can be sent once reconnected
      enableOfflineQueue: true,
      // Connection timeout in ms
      connectTimeout: 10000,
    });

    // Set up connection event handlers
    this.setupEventHandlers();

    // Initiate connection
    this.connect();
  }

  /**
   * Set up Redis connection event handlers
   *
   * Handles ready, error, close, and reconnecting events to maintain
   * accurate connection state.
   */
  private setupEventHandlers(): void {
    // Connection established successfully
    this.client.on('ready', () => {
      this._connected = true;
      this._state = 'connected';
      this.retryCount = 0;
    });

    // Connection error
    this.client.on('error', (err: Error) => {
      this._connected = false;
      this._state = 'disconnected';

      // Log error but don't throw - let tools handle via checkConnection()
      console.error('[Redis] Connection error:', err.message);
    });

    // Connection closed
    this.client.on('close', () => {
      this._connected = false;
      this._state = 'disconnected';
    });

    // Attempting to reconnect
    this.client.on('reconnecting', () => {
      this._state = 'reconnecting';
      this.retryCount++;
    });
  }

  /**
   * Initiate connection to Redis server
   *
   * Uses a promise-based approach to avoid duplicate connection attempts.
   */
  private connect(): void {
    if (this.connectionPromise) {
      return;
    }

    this._state = 'connecting';
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      // If already connected via event, resolve immediately
      if (this.client.status === 'ready') {
        this._connected = true;
        this._state = 'connected';
        resolve();
        return;
      }

      // One-time error handler for initial connection
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
    }).finally(() => {
      this.connectionPromise = null;
    });
  }

  /**
   * Get current connection state
   *
   * @returns ConnectionState enum value: disconnected, connecting, connected, or reconnecting
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Check if Redis client is currently connected
   *
   * Use this getter for quick connection state checks.
   * For tool execution, prefer checkConnection() which provides error handling.
   *
   * @returns True if connected and ready to accept commands
   */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Check if connection is available and ready for operations
   *
   * This is the primary method for tools to verify connectivity before executing.
   * Returns true if the client is connected, false otherwise.
   *
   * @returns True if connected and ready for Redis operations
   */
  checkConnection(): boolean {
    return this._connected && this.client.status === 'ready';
  }

  /**
   * Wait for connection to be established
   *
   * Useful for initialization scenarios where you need to ensure
   * Redis is available before proceeding.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
   * @returns Promise that resolves when connected, rejects on timeout
   */
  async waitForConnection(timeoutMs = 5000): Promise<void> {
    if (this.checkConnection()) {
      return;
    }

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new RedisConnectionError(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const connected = this.connectionPromise ?? Promise.resolve();

    return Promise.race([connected, timeout]);
  }

  /**
   * Publish a message to a Redis pub/sub channel
   *
   * @param channel - The channel name to publish to
   * @param message - The message to publish
   * @returns Promise resolving to the number of subscribers that received the message
   * @throws RedisConnectionError if not connected
   */
  async publish(channel: string, message: string): Promise<number> {
    if (!this.checkConnection()) {
      throw new RedisConnectionError('Cannot publish: Redis is not connected');
    }
    return this.client.publish(channel, message);
  }

  /**
   * Subscribe to a Redis pub/sub channel
   *
   * Registers the callback for the channel. Subsequent calls with the same
   * channel will add additional callbacks (deduplication is per-callback).
   * The underlying Redis subscription is only called once per channel.
   *
   * @param channel - The channel name to subscribe to
   * @param callback - Function called when message is received
   */
  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.checkConnection()) {
      throw new RedisConnectionError('Cannot subscribe: Redis is not connected');
    }

    // Track callback for this channel
    if (!this.channelCallbacks.has(channel)) {
      this.channelCallbacks.set(channel, new Set());

      // First callback for this channel - subscribe to Redis
      await this.client.subscribe(channel);

      // Set up the message handler (only once per channel)
      this.client.on('message', (ch: string, msg: string) => {
        if (ch === channel) {
          const callbacks = this.channelCallbacks.get(ch);
          if (callbacks) {
            for (const cb of callbacks) {
              cb(msg);
            }
          }
        }
      });
    }

    // Add callback to the set (deduplicated)
    this.channelCallbacks.get(channel)!.add(callback);
  }

  /**
   * Unsubscribe from a Redis pub/sub channel
   *
   * Removes all callbacks for the channel and unsubscribes from Redis.
   *
   * @param channel - The channel name to unsubscribe from
   */
  async unsubscribe(channel: string): Promise<void> {
    if (!this.checkConnection()) {
      throw new RedisConnectionError('Cannot unsubscribe: Redis is not connected');
    }

    // Remove all callbacks for this channel
    this.channelCallbacks.delete(channel);

    // Unsubscribe from Redis (only if no callbacks remain)
    await this.client.unsubscribe(channel);
  }

  /**
   * Get the underlying ioredis client for advanced operations
   *
   * Use with caution - prefer using the wrapper methods when possible.
   *
   * @returns The raw ioredis client instance
   */
  getClient(): Redis {
    return this.client;
  }

  /**
   * Create a new dedicated ioredis client
   *
   * Use this for operations that block the connection (like BRPOP/BLPOP).
   * Each blocking operation should use its own dedicated client.
   *
   * @returns A new ioredis client instance
   */
  createClient(): Redis {
    const redisUrl = process.env.AGENTBUS_REDIS_URL ?? 'redis://localhost:6379';
    return new Redis(redisUrl, {
      maxRetriesPerRequest: this.maxRetries,
      retryStrategy: (times: number) => {
        if (times > this.maxRetries) {
          return null;
        }
        return this.retryDelayMs;
      },
      enableOfflineQueue: true,
      connectTimeout: 10000,
    });
  }

  /**
   * Close the Redis connection
   *
   * Calls disconnect() on the underlying client.
   * After calling this, the client is no longer usable.
   */
  async close(): Promise<void> {
    this._connected = false;
    this._state = 'disconnected';
    await this.client.quit();
  }

  /**
   * Force close the connection without graceful shutdown
   *
   * Use this for cleanup scenarios where graceful shutdown is not needed.
   */
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

