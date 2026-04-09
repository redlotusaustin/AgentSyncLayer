/**
 * SQLite client module for AgentBus
 *
 * Provides durable message persistence using SQLite with FTS5 full-text search.
 * Maintains message history in WAL mode for concurrent access.
 *
 * Features:
 * - WAL mode for concurrent reads during writes
 * - FTS5 virtual table for full-text search
 * - Prepared statements for performance
 * - Graceful degradation when SQLite unavailable
 *
 * Architecture:
 * - Singleton pattern: one SqliteClient per project directory
 * - Prepared statements cached for read/write performance
 * - FTS5 triggers auto-index message content for search
 * - WAL mode allows concurrent reads during writes
 *
 * @example
 * const sqlite = getSqliteClient(directory, projectHash);
 * if (sqlite?.available) {
 *   sqlite.insertMessage(message);
 *   const { messages, total } = sqlite.getMessages({ projectHash, channel: 'general', limit: 50, offset: 0 });
 * }
 */

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import type { Message } from './types';

/**
 * Error thrown when SQLite initialization fails.
 * Indicates the database directory couldn't be created or the database couldn't be opened.
 */
export class SqliteInitializationError extends Error {
  /** Error code for this exception type */
  public readonly code = 'SQLITE_UNAVAILABLE';

  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'SqliteInitializationError';
  }
}

/**
 * Options for querying message history with pagination.
 */
export interface HistoryQueryOptions {
  /** 12-character project hash for namespace isolation */
  projectHash: string;
  /** Channel to filter by, or null for all channels */
  channel?: string | null;
  /** Maximum number of messages to return */
  limit: number;
  /** Number of messages to skip (for pagination offset) */
  offset: number;
}

/**
 * Options for querying messages newer than a timestamp.
 */
export interface MessagesSinceOptions {
  /** 12-character project hash for namespace isolation */
  projectHash: string;
  /** Unix timestamp in milliseconds - return messages newer than this */
  sinceUnixMs: number;
  /** Maximum number of messages to return (default: 50) */
  limit?: number;
}

/**
 * SQLite client for AgentBus message persistence.
 *
 * Manages a SQLite database in WAL mode with FTS5 full-text search.
 * Provides message storage, retrieval, and search capabilities.
 *
 * @example
 * const client = new SqliteClient('/path/to/project');
 * client.insertMessage(message);
 * const { messages, total } = client.getMessages({ projectHash, limit: 50, offset: 0 });
 * client.close();
 */
export class SqliteClient {
  private db: Database;
  private dbPath: string;
  private _available = true;

  /**
   * Create a new SQLite client for a project.
   *
   * @param directory - The project directory path (used for .agentbus/ subdirectory)
   * @throws {SqliteInitializationError} If the database directory cannot be created or the database cannot be opened
   */
  constructor(directory: string) {
    let dbDir: string;
    try {
      dbDir = path.join(directory, '.agentbus');
      fs.mkdirSync(dbDir, { recursive: true });
    } catch (error) {
      this._available = false;
      throw new SqliteInitializationError(
        `Failed to create database directory: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }

    this.dbPath = path.join(dbDir, 'history.db');

    try {
      this.db = new Database(this.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.initializeSchema();
    } catch (error) {
      this._available = false;
      throw new SqliteInitializationError(
        `Failed to initialize SQLite at ${this.dbPath}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Whether this client is available for operations.
   * Returns false if the database failed to initialize or has been closed.
   */
  get available(): boolean {
    return this._available;
  }

  /**
   * Alias for available getter — RFC compatibility.
   * @returns true if the SQLite client is ready for operations
   */
  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Get the file path to this database.
   * Useful for debugging and testing.
   * @returns Absolute path to the history.db file
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Initialize the database schema.
   *
   * Creates tables if they don't exist:
   * - messages: Core message storage with indexes
   * - channels: Channel registry with message counts
   * - messages_fts: FTS5 virtual table for full-text search
   *
   * Also sets up:
   * - AFTER INSERT trigger on messages to auto-index FTS content
   * - Prepared statements for all read/write operations
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        "from" TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        project TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel
        ON messages(channel, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_project
        ON messages(project, channel, created_at DESC);

      CREATE TABLE IF NOT EXISTS channels (
        name TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_channels_project
        ON channels(project);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        id UNINDEXED,
        channel,
        "from",
        type UNINDEXED,
        text,
        payload
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(id, channel, "from", type, text, payload)
        VALUES (new.id, new.channel, new."from", new.type, json_extract(new.payload, '$.text'), new.payload);
      END;
    `);

    // Prepare frequently-used statements
    this.prepareStatements();
  }

  // Prepared statements for write operations
  private stmtInsertMessage!: ReturnType<Database['prepare']>;
  private stmtUpsertChannel!: ReturnType<Database['prepare']>;

  // Prepared statements for read operations (R-9: cache read queries)
  private stmtGetMessagesByChannel!: ReturnType<Database['prepare']>;
  private stmtGetMessagesAll!: ReturnType<Database['prepare']>;
  private stmtGetMessageCountByChannel!: ReturnType<Database['prepare']>;
  private stmtGetMessageCountAll!: ReturnType<Database['prepare']>;
  private stmtGetMessagesSince!: ReturnType<Database['prepare']>;
  private stmtSearchWithChannel!: ReturnType<Database['prepare']>;
  private stmtSearchAllChannels!: ReturnType<Database['prepare']>;
  private stmtGetMessageCountForChannel!: ReturnType<Database['prepare']>;
  private stmtGetAllMessageCount!: ReturnType<Database['prepare']>;

  /**
   * Prepare frequently-used SQL statements for performance.
   *
   * Writes:
   * - INSERT message (OR IGNORE for idempotency)
   * - UPSERT channel (increment count on conflict)
   *
   * Reads:
   * - Get messages by channel (paginated)
   * - Get all messages (paginated)
   * - Count messages by channel
   * - Count all messages
   * - Get messages since timestamp
   * - Search with channel filter
   * - Search all channels
   */
  private prepareStatements(): void {
    // Write statements
    this.stmtInsertMessage = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, channel, "from", type, payload, timestamp, project, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpsertChannel = this.db.prepare(`
      INSERT INTO channels (name, project, created_at, message_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET message_count = message_count + 1
    `);

    // Read statements (R-9: cache prepared statements for read paths)
    this.stmtGetMessagesByChannel = this.db.prepare(`
      SELECT * FROM messages
      WHERE project = ? AND channel = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    this.stmtGetMessagesAll = this.db.prepare(`
      SELECT * FROM messages
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    this.stmtGetMessageCountByChannel = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM messages WHERE project = ? AND channel = ?
    `);

    this.stmtGetMessageCountAll = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM messages WHERE project = ?
    `);

    this.stmtGetMessagesSince = this.db.prepare(`
      SELECT * FROM messages
      WHERE project = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    this.stmtSearchWithChannel = this.db.prepare(`
      SELECT m.*, fts.rank,
        snippet(messages_fts, 4, '>>', '<<', '...', 32) as snippet
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.id
      WHERE messages_fts MATCH ? AND m.project = ? AND m.channel = ?
      ORDER BY fts.rank
      LIMIT ?
    `);

    this.stmtSearchAllChannels = this.db.prepare(`
      SELECT m.*, fts.rank,
        snippet(messages_fts, 4, '>>', '<<', '...', 32) as snippet
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.id
      WHERE messages_fts MATCH ? AND m.project = ?
      ORDER BY fts.rank
      LIMIT ?
    `);

    this.stmtGetMessageCountForChannel = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM messages WHERE channel = ?
    `);

    this.stmtGetAllMessageCount = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM messages
    `);
  }

  /**
   * Insert a message into the database.
   *
   * Uses prepared statement for performance. Only updates channel count
   * if this is a new message (detected via changes > 0).
   * FTS5 is updated automatically via AFTER INSERT trigger.
   *
   * @param msg - The message to insert
   */
  insertMessage(msg: Message): void {
    const createdAt = new Date(msg.timestamp).getTime();
    const result = this.stmtInsertMessage.run(
      msg.id,
      msg.channel,
      msg.from,
      msg.type,
      JSON.stringify(msg.payload),
      msg.timestamp,
      msg.project,
      createdAt
    );
    // Only update channel count if this is a new message (not a duplicate)
    // FTS5 is updated automatically via AFTER INSERT trigger
    if (result.changes > 0) {
      this.stmtUpsertChannel.run(msg.channel, msg.project, createdAt);
    }
  }

  /**
   * Retrieve paginated messages from the database.
   *
   * @param opts - Query options including projectHash, channel filter, limit, and offset
   * @returns Object containing messages array and total count
   *
   * @example
   * const { messages, total } = sqlite.getMessages({
   *   projectHash: 'a1b2c3d4e5f6',
   *   channel: 'general',
   *   limit: 50,
   *   offset: 0
   * });
   */
  getMessages(opts: HistoryQueryOptions): {
    messages: Message[];
    total: number;
  } {
    const { projectHash, channel, limit, offset } = opts;

    // Use cached prepared statement
    const rows = channel
      ? this.stmtGetMessagesByChannel.all(projectHash, channel, limit, offset) as any[]
      : this.stmtGetMessagesAll.all(projectHash, limit, offset) as any[];
    const messages = rows.map(rowToMessage);

    // Use cached prepared statement for count
    const countResult = channel
      ? this.stmtGetMessageCountByChannel.get(projectHash, channel) as { cnt: number }
      : this.stmtGetMessageCountAll.get(projectHash) as { cnt: number };
    const cnt = countResult?.cnt ?? 0;

    return { messages, total: cnt };
  }

  /**
   * Retrieve messages newer than a given timestamp.
   *
   * Used for unread message notifications. Returns messages with created_at
   * greater than the specified timestamp, sorted newest first.
   *
   * @param opts - Query options including projectHash, sinceUnixMs, and limit
   * @returns Array of messages newer than the timestamp
   */
  getMessagesSince(opts: MessagesSinceOptions): Message[] {
    const limit = opts.limit ?? 50;
    const rows = this.stmtGetMessagesSince.all(opts.projectHash, opts.sinceUnixMs, limit) as any[];
    return rows.map(rowToMessage);
  }

  /**
   * Perform full-text search on message history using FTS5.
   *
   * Searches across message text and payload content with relevance ranking.
   * Returns messages with snippet highlighting and rank scores.
   *
   * @param projectHash - 12-character project hash
   * @param query - Search query text
   * @param channel - Optional channel to filter by
   * @param limit - Maximum results (default: 20)
   * @returns Array of search results with message, rank, and snippet
   */
  searchMessages(
    projectHash: string,
    query: string,
    channel?: string | null,
    limit = 20
  ): Array<{ message: Message; rank: number; snippet: string }> {
    // Sanitize FTS5 query: strip unmatched quotes, escape special chars
    const sanitized = sanitizeFts5Query(query);

    // Use cached prepared statement
    const rows = channel
      ? this.stmtSearchWithChannel.all(sanitized, projectHash, channel, limit) as any[]
      : this.stmtSearchAllChannels.all(sanitized, projectHash, limit) as any[];

    return rows.map(row => ({
      message: rowToMessage(row),
      rank: row.rank,
      snippet: row.snippet,
    }));
  }
  
  /**
   * Get the total message count in the database.
   *
   * @param channel - Optional channel to count messages for
   * @returns Total number of messages (for channel or all channels)
   */
  getMessageCount(channel?: string): number {
    const result = channel
      ? this.stmtGetMessageCountForChannel.get(channel) as { cnt: number }
      : this.stmtGetAllMessageCount.get() as { cnt: number };
    return result?.cnt ?? 0;
  }

  /**
   * Close the database connection and mark as unavailable.
   *
   * After calling close(), all operations will fail until a new client is created.
   * This should be called on session end to clean up resources.
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
    this._available = false;
  }
}

/**
 * Convert a database row to a Message object.
 *
 * Parses the JSON payload string back into an object and maps
 * the 'from' column to the 'from' field (SQLite uses quotes for reserved words).
 *
 * @param row - Database row object with id, channel, from, type, payload, timestamp, project
 * @returns Parsed Message object
 */
function rowToMessage(row: any): Message {
  return {
    id: row.id,
    from: row.from,
    channel: row.channel,
    type: row.type,
    payload: JSON.parse(row.payload),
    timestamp: row.timestamp,
    project: row.project,
  };
}

/**
 * Sanitize a search query for FTS5.
 *
 * FTS5 query syntax can include operators like AND, OR, NOT, and quotes for phrase matching.
 * This function strips potentially dangerous syntax while preserving useful features:
 * - Removes unmatched double quotes (prevents query injection)
 * - Wraps the query in quotes for phrase matching
 * - Appends wildcard for prefix matching
 *
 * @param query - Raw search query from user
 * @returns Sanitized FTS5 query safe for use with MATCH operator
 *
 * @example
 * sanitizeFts5Query('hello world')  // => '"hello world"*'
 * sanitizeFts5Query('"test')       // => '"test"*'
 * sanitizeFts5Query('')            // => '*'
 */
function sanitizeFts5Query(query: string): string {
  // Remove unmatched double quotes
  let sanitized = query.replace(/"/g, '');

  // Handle empty string after quote removal
  if (sanitized.length === 0) {
    return '*';
  }

  // Wrap in quotes for phrase matching
  sanitized = `"${sanitized}"`;

  // Append wildcard for prefix matching
  if (!sanitized.endsWith('*')) {
    sanitized += '*';
  }

  return sanitized;
}

/** Singleton map: directory -> SqliteClient (one client per project directory) */
const clientMap = new Map<string, SqliteClient>();

/**
 * Get or create a SQLite client for a project directory.
 *
 * Implements singleton pattern: returns cached client if one exists for the directory.
 * Creates a new client if one doesn't exist, or returns null if initialization fails.
 *
 * @param directory - The project directory path
 * @returns SqliteClient instance if successful, null if initialization failed
 *
 * @example
 * const sqlite = getSqliteClient('/path/to/project');
 * if (sqlite) {
 *   const messages = sqlite.getMessages({ projectHash, limit: 50, offset: 0 });
 * }
 */
export function getSqliteClient(directory: string): SqliteClient | null {
  const cached = clientMap.get(directory);
  if (cached) return cached;

  try {
    const client = new SqliteClient(directory);
    clientMap.set(directory, client);
    return client;
  } catch (error) {
    console.warn('[AgentBus] SQLite initialization failed:', error);
    return null;
  }
}

/**
 * Close and remove a SQLite client from the singleton map.
 *
 * Called on session end to clean up resources. After calling this,
 * a new client will be created if getSqliteClient is called again.
 *
 * @param directory - The project directory path
 *
 * @example
 * closeSqliteClient('/path/to/project');
 */
export function closeSqliteClient(directory: string): void {
  const client = clientMap.get(directory);
  if (client) {
    client.close();
    clientMap.delete(directory);
  }
}
