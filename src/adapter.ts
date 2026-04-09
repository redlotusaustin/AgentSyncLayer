/**
 * AgentBus OpenCode Plugin Adapter
 *
 * This module bridges the existing AgentBus tool implementations to OpenCode's
 * plugin API. It wraps each tool with proper Zod schemas and converts responses
 * to the string format OpenCode expects.
 *
 * Key features:
 * - Uses HeartbeatManager for consistent agent presence
 * - Shares agent ID with tools via getSessionAgentId()
 * - Handles session.compacting hook for coordination context injection
 * - Handles session cleanup on idle/end events
 */

import type { Plugin, PluginInput, ToolContext } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

import z from 'zod';
import { resolveBusConfig } from './config';
// Import modules for heartbeat and session management
import { HeartbeatManager } from './heartbeat';
// Import lifecycle helpers
import {
  cleanupAgent,
  formatCompactionContext,
  getActiveAgents,
  getMyClaims,
  getRecentMessages,
} from './lifecycle';
import { getRedisClient } from './redis';
import { getSessionAgentId } from './session';
import { closeSqliteClient, getSqliteClient } from './sqlite';
// Import existing tool implementations
import {
  busAgentsExecute,
  busChannelsExecute,
  busClaimExecute,
  busHistoryExecute,
  busInfoExecute,
  busListenExecute,
  busReadExecute,
  busReleaseExecute,
  busSearchExecute,
  busSendExecute,
  busStatusExecute,
  cleanupRateLimiter,
} from './tools';
import { buildNotificationText, getLastSeenTimestamp } from './tools/notifications';
// Import types for ToolContext conversion
import type { ToolContext as AgentBusToolContext } from './types';

// ============================================================================
// Bus Usage Instructions (injected into system prompt on every turn)
// ============================================================================

const BUS_INSTRUCTIONS: string[] = [
  '## AgentBus — Inter-Agent Communication',
  'You have access to AgentBus tools for coordinating with other agents in this project.',
  '',
  '**When to use the bus:**',
  '- Before starting a task: use bus_status to announce what you are working on',
  '- Before editing a file: use bus_claim to lock it (advisory), bus_release when done',
  '- After completing work: use bus_send to notify other agents of progress or findings',
  '- When blocked: use bus_send to ask other agents for help or context',
  '- To check for messages: bus_read (recent), bus_history (deep archive), bus_search (full-text)',
  '- To discover channels: bus_channels. To see who is active: bus_agents.',
  '',
  'Reply to unread message notifications promptly. Use bus_read to get full details.',
];

// ============================================================================
// Helper: Convert OpenCode ToolContext to AgentBus ToolContext
// ============================================================================

function toAgentBusContext(context: ToolContext): AgentBusToolContext {
  // Guard against missing or malformed context
  if (!context || typeof context.directory !== 'string' || !context.directory) {
    return {
      directory: process.cwd() || '.',
      worktree: undefined,
    };
  }
  return {
    directory: context.directory,
    worktree: context.worktree,
  };
}

// ============================================================================
// Helper: Convert tool response to string for OpenCode
// ============================================================================

function responseToString(response: unknown): string {
  return JSON.stringify(response, null, 2);
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * bus_send — Publish a message to an AgentBus channel
 */
const bus_send = tool({
  description:
    'Publish a message to an AgentBus channel. Use this to communicate with other agents in the project.',
  args: {
    channel: z
      .string()
      .min(1)
      .max(64)
      .describe("The channel name to publish to (e.g., 'general', 'claims', 'tasks')"),
    message: z.string().min(1).max(4096).describe('The message text to send'),
    type: z
      .enum(['info', 'status', 'error', 'coordination', 'claim', 'release'])
      .optional()
      .describe('Message type (default: info)'),
  },
  async execute(args, context) {
    const result = await busSendExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_read — Read recent messages from a channel
 */
const bus_read = tool({
  description:
    'Read recent messages from an AgentBus channel. Returns messages sorted newest first.',
  args: {
    channel: z.string().min(1).max(64).describe('The channel name to read from'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of messages to return (default: 20)'),
  },
  async execute(args, context) {
    const result = await busReadExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_channels — List all active channels
 */
const bus_channels = tool({
  description:
    'List all active channels in the current project. Shows channel names and message counts.',
  args: {},
  async execute(_args, context) {
    const result = await busChannelsExecute({}, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_status — Update this agent's status
 */
const bus_status = tool({
  description:
    "Update this agent's status for other agents to see. Includes task description, files, and subscribed channels.",
  args: {
    task: z.string().min(1).max(256).describe('Current task description (max 256 chars)'),
    files: z.array(z.string()).optional().describe('List of file paths this agent is working on'),
    channels: z
      .array(z.string())
      .optional()
      .describe("Channels this agent is subscribed to (default: ['general'])"),
  },
  async execute(args, context) {
    const result = await busStatusExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_agents — List all active agents
 */
const bus_agents = tool({
  description:
    'List all active agents in the current project with their status and subscribed channels.',
  args: {},
  async execute(_args, context) {
    const result = await busAgentsExecute({}, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_info — Get AgentBus configuration info
 */
const bus_info = tool({
  description:
    'Get AgentBus configuration info for the current project. Returns project hash, bus directory, db directory, and config source.',
  args: {},
  async execute(_args, context) {
    const result = await busInfoExecute({}, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_claim — Claim a file for editing
 */
const bus_claim = tool({
  description:
    'Claim a file for editing (advisory lock). Prevents other agents from editing the same file.',
  args: {
    path: z
      .string()
      .min(1)
      .max(512)
      .describe("The file path to claim (relative, e.g. 'src/auth/login.ts')"),
  },
  async execute(args, context) {
    const result = await busClaimExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_release — Release a file claim
 */
const bus_release = tool({
  description: 'Release a file claim. Must be the owner of the claim to release it.',
  args: {
    path: z
      .string()
      .max(512)
      .describe("The file path to release (relative, e.g. 'src/auth/login.ts')"),
  },
  async execute(args, context) {
    const result = await busReleaseExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_listen — Long-poll for new messages
 */
const bus_listen = tool({
  description:
    'Long-poll for new messages on specified channels. Waits for new messages or times out.',
  args: {
    channels: z
      .array(z.string())
      .optional()
      .describe("Channels to listen on (default: ['general'])"),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Timeout in seconds (default: 10, max: 30)'),
  },
  async execute(args, context) {
    const result = await busListenExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_history — Read deep message history from SQLite
 */
const bus_history = tool({
  description:
    'Read deep message history from SQLite. Returns paginated results sorted newest first. Use this to review past coordination or find messages older than what bus_read returns.',
  args: {
    channel: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Channel to filter by (omit for all channels)'),
    page: z.number().int().min(1).optional().describe('Page number (1-indexed, default: 1)'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Messages per page (default: 50)'),
  },
  async execute(args, context) {
    const result = await busHistoryExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_search — Search message history using full-text search
 */
const bus_search = tool({
  description:
    'Search message history using full-text search. Returns messages matching the query, ranked by relevance.',
  args: {
    query: z.string().min(1).max(256).describe('Search query text'),
    channel: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Channel to filter by (omit for all channels)'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default: 20)'),
  },
  async execute(args, context) {
    const result = await busSearchExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

// ============================================================================
// Plugin State
// ============================================================================

interface PluginState {
  projectHash: string | null;
  dbDir: string | null;
  heartbeatManager: HeartbeatManager | null;
  connected: boolean;
  directory: string | null;
}

// Mutable plugin state
const state: PluginState = {
  projectHash: null,
  dbDir: null,
  heartbeatManager: null,
  connected: false,
  directory: null,
};

// ============================================================================
// Plugin Factory
// ============================================================================

export const AgentSyncLayerPlugin: Plugin = async (input: PluginInput) => {
  const { directory } = input;
  const redis = getRedisClient();
  const busConfig = resolveBusConfig(directory);
  const projectHash = busConfig.projectHash;
  const dbDir = busConfig.db_dir;
  const agentId = getSessionAgentId(); // Same ID as tools use!

  // Wait for Redis connection (max 5 seconds)
  try {
    await redis.waitForConnection(5000);
    state.connected = true;
  } catch {
    console.warn('[AgentBus] Redis connection timeout, continuing anyway');
    state.connected = false;
  }

  // Create and start heartbeat using HeartbeatManager
  // This uses the SAME agent ID as tools (via getSessionAgentId)
  const heartbeatManager = new HeartbeatManager({
    agentId,
    projectHash,
    task: 'AgentBus active',
    files: [],
    claimedFiles: [],
    channels: ['general'],
    startedAt: new Date().toISOString(),
  });

  try {
    await heartbeatManager.start();
    state.heartbeatManager = heartbeatManager;
  } catch (error) {
    console.warn('[AgentBus] Failed to start heartbeat:', error);
  }

  state.projectHash = projectHash;
  state.dbDir = dbDir;
  state.directory = directory;

  // Initialize SQLite client (optional, graceful degradation)
  const sqlite = getSqliteClient(dbDir, projectHash);
  if (!sqlite) {
    console.warn('[AgentBus] SQLite not available, running in Redis-only mode');
  }

  return {
    tool: {
      bus_send,
      bus_read,
      bus_channels,
      bus_status,
      bus_agents,
      bus_info,
      bus_claim,
      bus_release,
      bus_listen,
      bus_history,
      bus_search,
    },

    // Session compaction hook - inject coordination context
    'experimental.session.compacting': async (_input, output) => {
      if (!state.connected || !state.projectHash) {
        return;
      }

      const agentId = getSessionAgentId();

      // Fetch coordination data in parallel using lifecycle helpers
      const [agents, myClaims, recentMessages] = await Promise.all([
        getActiveAgents(state.projectHash),
        getMyClaims(state.projectHash, agentId),
        getRecentMessages(state.projectHash, ['general', 'claims'], 5, agentId),
      ]);

      const contextText = formatCompactionContext(agents, myClaims, recentMessages);
      output.context.push(contextText);
    },

    // System transform hook - inject bus instructions + unread notifications
    'experimental.chat.system.transform': async (_input, output) => {
      // Always inject bus usage instructions on every turn
      output.system.push(...BUS_INSTRUCTIONS);

      // Inject unread message notifications (requires SQLite)
      if (!state.projectHash || !state.dbDir) {
        return;
      }

      const agentId = getSessionAgentId();
      const sqlite = getSqliteClient(state.dbDir, state.projectHash);
      if (!sqlite) {
        return;
      }

      const lastSeen = await getLastSeenTimestamp(state.projectHash, agentId);
      const unread = sqlite.getMessagesSince({
        projectHash: state.projectHash,
        sinceUnixMs: lastSeen,
        limit: 50,
      });

      if (unread.length === 0) {
        return;
      }

      // Build notification lines using shared function
      const lines = buildNotificationText(unread);
      if (!lines) {
        return;
      }

      // Append notification lines to system array
      output.system.push(...lines);
    },

    // Event handler for cleanup
    event: async (payload) => {
      const { event } = payload;

      // Handle session cleanup events
      // Note: "session.idle" and "session.deleted" are the actual session events in OpenCode SDK
      if (event.type === 'session.idle' || event.type === 'session.deleted') {
        // Stop heartbeat
        if (state.heartbeatManager) {
          state.heartbeatManager.stop();
          state.heartbeatManager = null;
        }

        // Clean up agent resources using lifecycle helper
        if (state.connected && state.projectHash) {
          const agentId = getSessionAgentId();
          await cleanupAgent(state.projectHash, agentId);
        }

        // Clean up rate limiter
        cleanupRateLimiter();

        // Close SQLite connection
        if (state.dbDir) {
          closeSqliteClient(state.dbDir);
          state.dbDir = null;
        }

        state.connected = false;
      }
    },
  };
};

// Export as default for convenience
export default AgentSyncLayerPlugin;
