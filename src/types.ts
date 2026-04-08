/**
 * TypeScript type definitions for AgentBus
 *
 * Defines interfaces for messages, agent status, claims, and tool responses
 * following the contract.md specifications.
 */

/** Message type categories */
export type MessageType = 'info' | 'status' | 'error' | 'coordination' | 'claim' | 'release';

/**
 * AgentBus message structure - all messages flowing through the bus
 * conform to this JSON schema.
 */
export interface Message {
  /** Unique message identifier (v4 UUID) */
  id: string;
  /** Agent ID that sent the message (hostname-pid-random4) */
  from: string;
  /** Channel name (lowercase) */
  channel: string;
  /** Message type category */
  type: MessageType;
  /** Message payload (extensible) */
  payload: MessagePayload;
  /** ISO 8601 timestamp when the message was created */
  timestamp: string;
  /** Project hash for namespace isolation (12-char lowercase hex) */
  project: string;
}

/**
 * Message payload structure
 */
export interface MessagePayload {
  /** Message body text */
  text: string;
  /** Optional list of related file paths */
  files?: string[];
  /** Allow additional properties for extensibility */
  [key: string]: unknown;
}

/**
 * Agent status stored in Redis with TTL
 */
export interface AgentStatus {
  /** Agent ID */
  id: string;
  /** Brief description of current task */
  task: string;
  /** List of files currently being worked on */
  files: string[];
  /** List of files claimed by this agent */
  claimedFiles: string[];
  /** Channels this agent is listening to */
  channels: string[];
  /** Session start time */
  startedAt: string;
  /** Last heartbeat timestamp */
  lastHeartbeat: string;
}

/**
 * File claim structure stored in Redis with TTL
 */
export interface Claim {
  /** File path being claimed */
  path: string;
  /** Agent ID that holds the claim */
  agentId: string;
  /** ISO 8601 timestamp when claim was acquired */
  claimedAt: string;
  /** ISO 8601 timestamp when claim expires */
  expiresAt: string;
}

/**
 * Error codes for tool responses
 */
export type ErrorCode =
  | 'BUS_UNAVAILABLE'
  | 'CHANNEL_INVALID'
  | 'CLAIM_CONFLICT'
  | 'CLAIM_NOT_FOUND'
  | 'PATH_INVALID'
  | 'QUERY_INVALID'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SQLITE_UNAVAILABLE';

/**
 * Common error response format
 */
export interface ErrorResponse {
  ok: false;
  error: string;
  code: ErrorCode;
}

/**
 * Common success response envelope
 */
export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

/**
 * Tool response type (success or error)
 */
export type ToolResponse<T> = SuccessResponse<T> | ErrorResponse;

/**
 * Response data for bus_send tool
 */
export interface SendResponseData {
  id: string;
  channel: string;
  timestamp: string;
}

/**
 * Response data for bus_read tool
 */
export interface ReadResponseData {
  channel: string;
  messages: Message[];
  count: number;
  total: number;
}

/**
 * Channel info with message count
 */
export interface ChannelInfo {
  name: string;
  messages: number;
}

/**
 * Response data for bus_channels tool
 */
export interface ChannelsResponseData {
  channels: ChannelInfo[];
  count: number;
}

/**
 * Response data for bus_status tool
 */
export interface StatusResponseData {
  agentId: string;
  task: string;
  files: string[];
  expiresAt: string;
}

/**
 * Response data for bus_agents tool
 */
export interface AgentsResponseData {
  agents: AgentStatus[];
  count: number;
}

/**
 * Response data for bus_claim tool (success)
 */
export interface ClaimResponseData {
  path: string;
  agentId: string;
  claimedAt: string;
  expiresAt: string;
}

/**
 * Data included in CLAIM_CONFLICT error response
 */
export interface ClaimConflictData {
  path: string;
  heldBy: string;
  claimedAt: string;
  expiresAt: string;
}

/**
 * Claim conflict error response
 */
export interface ClaimConflictError extends ErrorResponse {
  code: 'CLAIM_CONFLICT';
  data: ClaimConflictData;
}

/**
 * Response data for bus_release tool
 */
export interface ReleaseResponseData {
  path: string;
  released: boolean;
}

/**
 * Response data for bus_listen tool
 */
export interface ListenResponseData {
  messages: Message[];
  count: number;
  polled: boolean;
  timeout: boolean;
}

/**
 * Response data for bus_history tool
 */
export interface HistoryResponseData {
  messages: Message[];
  count: number;
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

/**
 * A single search result with message and metadata
 */
export interface SearchResult {
  message: Message;
  rank: number;
  snippet: string;
}

/**
 * Response data for bus_search tool
 */
export interface SearchResponseData {
  results: SearchResult[];
  count: number;
  query: string;
}

/**
 * Response data for bus_info tool
 */
export interface BusInfoResponseData {
  projectHash: string;
  bus_dir: string;
  db_dir: string;
  source: 'env' | 'config' | 'default';
  configPath: string | null;
}

/**
 * Rate limiter bucket structure
 */
export interface RateLimiterBucket {
  count: number;
  windowStart: number;
}

/**
 * Plugin context passed to tool execute functions
 */
export interface ToolContext {
  /** Project directory */
  directory: string;
  /** Worktree path (if applicable) */
  worktree?: string;
}

/**
 * Tool arguments base
 */
export interface ToolArgs {
  [key: string]: unknown;
}

/**
 * Tool execute function signature
 */
export type ToolExecute<T extends ToolArgs, R> = (args: T, context: ToolContext) => Promise<ToolResponse<R>>;

/**
 * Redis key types for namespace construction
 */
export type KeyType = 'ch' | 'history' | 'agent' | 'claim' | 'channels' | 'lastseen';

/**
 * Validation error structure
 */
export interface ValidationError {
  message: string;
  code: ErrorCode;
}
