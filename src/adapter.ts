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

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin";

import z from "zod";

// Import existing tool implementations
import {
  busSendExecute,
  busReadExecute,
  busChannelsExecute,
  busStatusExecute,
  busAgentsExecute,
  busClaimExecute,
  busReleaseExecute,
  busListenExecute,
  cleanupRateLimiter,
} from "./tools";

// Import types for ToolContext conversion
import type { ToolContext as AgentBusToolContext } from "./types";

// Import modules for heartbeat and session management
import { HeartbeatManager } from "./heartbeat";
import { getSessionAgentId } from "./session";
import { getRedisClient } from "./redis";
import { hashProjectPath } from "./namespace";

// Import lifecycle helpers
import {
  getActiveAgents,
  getMyClaims,
  getRecentMessages,
  formatCompactionContext,
  cleanupAgent,
} from "./lifecycle";

// ============================================================================
// Helper: Convert OpenCode ToolContext to AgentBus ToolContext
// ============================================================================

function toAgentBusContext(context: ToolContext): AgentBusToolContext {
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
  description: "Publish a message to an AgentBus channel. Use this to communicate with other agents in the project.",
  args: {
    channel: z.string().min(1).max(64).describe("The channel name to publish to (e.g., 'general', 'claims', 'tasks')"),
    message: z.string().min(1).max(4096).describe("The message text to send"),
    type: z.enum(["info", "status", "error", "coordination", "claim", "release"]).optional().describe("Message type (default: info)"),
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
  description: "Read recent messages from an AgentBus channel. Returns messages sorted newest first.",
  args: {
    channel: z.string().min(1).max(64).describe("The channel name to read from"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum number of messages to return (default: 20)"),
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
  description: "List all active channels in the current project. Shows channel names and message counts.",
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
  description: "Update this agent's status for other agents to see. Includes task description, files, and subscribed channels.",
  args: {
    task: z.string().min(1).max(256).describe("Current task description (max 256 chars)"),
    files: z.array(z.string()).optional().describe("List of file paths this agent is working on"),
    channels: z.array(z.string()).optional().describe("Channels this agent is subscribed to (default: ['general'])"),
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
  description: "List all active agents in the current project with their status and subscribed channels.",
  args: {},
  async execute(_args, context) {
    const result = await busAgentsExecute({}, toAgentBusContext(context));
    return responseToString(result);
  },
});

/**
 * bus_claim — Claim a file for editing
 */
const bus_claim = tool({
  description: "Claim a file for editing (advisory lock). Prevents other agents from editing the same file.",
  args: {
    path: z.string().describe("The file path to claim"),
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
  description: "Release a file claim. Must be the owner of the claim to release it.",
  args: {
    path: z.string().describe("The file path to release"),
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
  description: "Long-poll for new messages on specified channels. Waits for new messages or times out.",
  args: {
    channels: z.array(z.string()).optional().describe("Channels to listen on (default: ['general'])"),
    timeout: z.number().int().min(1).max(30).optional().describe("Timeout in seconds (default: 10, max: 30)"),
  },
  async execute(args, context) {
    const result = await busListenExecute(args, toAgentBusContext(context));
    return responseToString(result);
  },
});

// ============================================================================
// Plugin State
// ============================================================================

interface PluginState {
  projectHash: string | null;
  heartbeatManager: HeartbeatManager | null;
  connected: boolean;
}

// Mutable plugin state
const state: PluginState = {
  projectHash: null,
  heartbeatManager: null,
  connected: false,
};

// ============================================================================
// Plugin Factory
// ============================================================================

export const AgentBusPlugin: Plugin = async (input: PluginInput) => {
  const { directory } = input;
  const redis = getRedisClient();
  const projectHash = hashProjectPath(directory);
  const agentId = getSessionAgentId(); // Same ID as tools use!

  // Wait for Redis connection (max 5 seconds)
  try {
    await redis.waitForConnection(5000);
    state.connected = true;
  } catch {
    console.warn("[AgentBus] Redis connection timeout, continuing anyway");
    state.connected = false;
  }

  // Create and start heartbeat using HeartbeatManager
  // This uses the SAME agent ID as tools (via getSessionAgentId)
  const heartbeatManager = new HeartbeatManager({
    agentId,
    projectHash,
    task: "AgentBus active",
    files: [],
    claimedFiles: [],
    channels: ["general"],
    startedAt: new Date().toISOString(),
  });

  try {
    await heartbeatManager.start();
    state.heartbeatManager = heartbeatManager;
  } catch (error) {
    console.warn("[AgentBus] Failed to start heartbeat:", error);
  }

  state.projectHash = projectHash;

  return {
    tool: {
      bus_send,
      bus_read,
      bus_channels,
      bus_status,
      bus_agents,
      bus_claim,
      bus_release,
      bus_listen,
    },

    // Session compaction hook - inject coordination context
    "experimental.session.compacting": async (_input, output) => {
      if (!state.connected || !state.projectHash) {
        return;
      }

      const agentId = getSessionAgentId();

      // Fetch coordination data in parallel using lifecycle helpers
      const [agents, myClaims, recentMessages] = await Promise.all([
        getActiveAgents(state.projectHash),
        getMyClaims(state.projectHash, agentId),
        getRecentMessages(state.projectHash, ["general", "claims"], 5, agentId),
      ]);

      const contextText = formatCompactionContext(agents, myClaims, recentMessages);
      output.context.push(contextText);
    },

    // Event handler for cleanup
    event: async (payload) => {
      const { event } = payload;

      // Handle session cleanup events
      // Note: "session.idle" and "session.deleted" are the actual session events in OpenCode SDK
      if (event.type === "session.idle" || event.type === "session.deleted") {
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

        state.connected = false;
      }
    },
  };
};

// Export as default for convenience
export default AgentBusPlugin;
