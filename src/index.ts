/**
 * AgentBus Plugin Entry Point
 *
 * Provides Redis-backed pub/sub messaging for OpenCode agent coordination.
 *
 * Features:
 * - Agent presence via heartbeat status
 * - File claim protocol (advisory locks)
 * - Channel-based messaging
 * - Session compaction context injection
 * - Graceful cleanup on session end
 *
 * Usage:
 *   import AgentBus from './src/index';
 *   // OpenCode loads and calls this function with context
 */

import type { AgentStatus, Claim, Message } from './types';

// Re-export tools for external access
export {
  busSendExecute,
  busReadExecute,
  busChannelsExecute,
  busStatusExecute,
  busAgentsExecute,
  busClaimExecute,
  busReleaseExecute,
  busListenExecute,
} from './tools';
export type {
  BusSendArgs,
  BusReadArgs,
  BusStatusArgs,
  BusClaimArgs,
  BusReleaseArgs,
  BusListenArgs,
} from './tools';

// Re-export types
export type {
  Message,
  AgentStatus,
  Claim,
  ToolResponse,
  SendResponseData,
  ReadResponseData,
  ChannelsResponseData,
  StatusResponseData,
  AgentsResponseData,
  ClaimResponseData,
  ReleaseResponseData,
  ListenResponseData,
} from './types';

/**
 * Plugin context passed by OpenCode
 */
interface PluginContext {
  /** Project directory path */
  directory: string;
  /** Worktree path if applicable */
  worktree?: string;
  /** Project identifier */
  project: string;
}

/**
 * Compaction hook input (from OpenCode)
 */
interface CompactionInput {
  // OpenCode provides session context here
}

/**
 * Compaction hook output (to OpenCode)
 */
interface CompactionOutput {
  context: string[];
}

/**
 * Event types from OpenCode
 */
type EventType = 'session.start' | 'session.idle' | 'session.end';

/**
 * Plugin event payload
 */
interface PluginEvent {
  event: {
    type: EventType;
    [key: string]: unknown;
  };
}

/**
 * Tool definition for OpenCode plugin API
 */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Plugin return type with hooks
 */
interface AgentBusPlugin {
  tool: ToolDefinition[];
  'experimental.session.compacting'?: (
    input: CompactionInput,
    output: CompactionOutput
  ) => Promise<void>;
  event?: (payload: PluginEvent) => Promise<void>;
}

/**
 * AgentBus plugin factory
 *
 * Creates the plugin instance with all tools, hooks, and event handlers.
 *
 * @param context - Plugin context from OpenCode
 * @returns Plugin hooks and tool definitions
 */
export default function AgentBusPlugin(context: PluginContext): AgentBusPlugin {
  const { directory } = context;

  // Lazy imports to avoid circular dependencies
  let getRedisClient: () => import('./redis').RedisClient;
  let hashProjectPath: (path: string) => string;
  let generateAgentId: () => string;
  let HeartbeatManager: typeof import('./heartbeat').HeartbeatManager;
  let heartbeatManager: import('./heartbeat').HeartbeatManager | null = null;
  let connected = false;

  // Track agent state for cleanup
  let agentId: string | null = null;
  let projectHash: string | null = null;

  /**
   * Initialize lazy dependencies and Redis connection
   */
  async function initialize(): Promise<void> {
    if (agentId && projectHash) {
      return; // Already initialized
    }

    // Dynamic imports to avoid circular deps
    const redis = await import('./redis');
    const namespace = await import('./namespace');
    const agent = await import('./agent');
    const heartbeat = await import('./heartbeat');

    getRedisClient = redis.getRedisClient;
    hashProjectPath = namespace.hashProjectPath;
    generateAgentId = agent.generateAgentId;
    HeartbeatManager = heartbeat.HeartbeatManager;

    agentId = generateAgentId();
    projectHash = hashProjectPath(directory);
  }

  /**
   * Start heartbeat for agent presence
   */
  async function startHeartbeat(): Promise<void> {
    await initialize();
    if (!agentId || !projectHash) return;

    const redis = getRedisClient();

    // Set up connection event handlers
    redis.getClient().on('ready', () => {
      connected = true;
    });

    redis.getClient().on('error', (err: Error) => {
      console.warn('[AgentBus] Redis error:', err.message);
      connected = false;
    });

    redis.getClient().on('close', () => {
      connected = false;
    });

    // Start heartbeat if connected
    if (redis.checkConnection()) {
      connected = true;
      heartbeatManager = new HeartbeatManager({
        agentId,
        projectHash,
        task: 'Initializing',
        files: [],
        claimedFiles: [],
        channels: ['general'],
        startedAt: new Date().toISOString(),
      });
      await heartbeatManager.start();
    }
  }

  /**
   * Stop heartbeat and clean up resources
   */
  async function stopHeartbeat(): Promise<void> {
    if (heartbeatManager) {
      heartbeatManager.stop();
      heartbeatManager = null;
    }
  }

  /**
   * Get all active agents from Redis
   */
  async function getActiveAgents(): Promise<AgentStatus[]> {
    if (!connected || !projectHash) {
      return [];
    }

    const redis = getRedisClient();
    const client = redis.getClient();
    const agentPattern = `opencode:${projectHash}:agent:*`;

    const agentKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', agentPattern, 'COUNT', 100);
      cursor = nextCursor;
      agentKeys.push(...keys);
    } while (cursor !== '0' && agentKeys.length < 1000);

    const statuses = await Promise.all(
      agentKeys.map(async (key) => {
        const data = await client.get(key);
        if (!data) return null;
        try {
          return JSON.parse(data) as AgentStatus;
        } catch {
          return null;
        }
      })
    );

    return statuses
      .filter((status): status is AgentStatus => {
        if (!status) return false;
        const heartbeatAge = Date.now() - new Date(status.lastHeartbeat).getTime();
        return heartbeatAge < 90000; // 90 seconds
      })
      .sort((a, b) => new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime());
  }

  /**
   * Get all claims held by this agent
   */
  async function getMyClaims(): Promise<Claim[]> {
    if (!connected || !projectHash || !agentId) {
      return [];
    }

    const redis = getRedisClient();
    const client = redis.getClient();
    const claimPattern = `opencode:${projectHash}:claim:*`;

    const claimKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', claimPattern, 'COUNT', 100);
      cursor = nextCursor;
      claimKeys.push(...keys);
    } while (cursor !== '0' && claimKeys.length < 1000);

    const claims: Claim[] = [];
    const prefix = `opencode:${projectHash}:claim:`;
    for (const key of claimKeys) {
      const data = await client.get(key);
      if (!data) continue;
      try {
        const claim = JSON.parse(data) as Claim;
        if (claim.agentId === agentId) {
          // Extract path from key if not present in claim
          if (!claim.path && key.startsWith(prefix)) {
            claim.path = key.slice(prefix.length);
          }
          claims.push(claim);
        }
      } catch {
        // Skip malformed
      }
    }

    return claims;
  }

  /**
   * Get recent messages from channels
   */
  async function getRecentMessages(channels: string[], limit = 5): Promise<Message[]> {
    if (!connected || !projectHash) {
      return [];
    }

    const redis = getRedisClient();
    const client = redis.getClient();

    const allMessages: Message[] = [];

    for (const channel of channels) {
      const historyKey = `opencode:${projectHash}:history:${channel}`;
      const rawMessages = await client.zrevrange(historyKey, 0, limit - 1);

      for (const raw of rawMessages) {
        try {
          const msg = JSON.parse(raw) as Message;
          // Filter out messages from this agent
          if (msg.from !== agentId) {
            allMessages.push(msg);
          }
        } catch {
          // Skip malformed
        }
      }
    }

    // Sort by timestamp descending
    return allMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Format compaction context as markdown text
   */
  function formatCompactionContext(
    agents: AgentStatus[],
    myClaims: Claim[],
    recentMessages: Message[]
  ): string {
    const lines: string[] = [];
    lines.push('## AgentBus — Active Coordination State');
    lines.push('');

    if (agents.length > 0) {
      lines.push(`### Active Agents (${agents.length})`);
      for (const agent of agents) {
        lines.push(`- **${agent.id}**: ${agent.task}`);
        if (agent.files.length > 0) {
          lines.push(`  Files: ${agent.files.join(', ')}`);
        }
      }
      lines.push('');
    }

    if (recentMessages.length > 0) {
      lines.push('### Recent Messages');
      for (const msg of recentMessages) {
        lines.push(`- [${msg.channel}] ${msg.from}: ${msg.payload.text}`);
      }
      lines.push('');
    }

    if (myClaims.length > 0) {
      lines.push('### Your File Claims');
      for (const claim of myClaims) {
        lines.push(`- ${claim.path} (expires ${claim.expiresAt})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Release all claims held by this agent
   */
  async function releaseAllClaims(): Promise<void> {
    if (!connected || !projectHash || !agentId) {
      return;
    }

    const redis = getRedisClient();
    const client = redis.getClient();
    const claimPattern = `opencode:${projectHash}:claim:*`;

    const claimKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', claimPattern, 'COUNT', 100);
      cursor = nextCursor;
      claimKeys.push(...keys);
    } while (cursor !== '0' && claimKeys.length < 1000);

    for (const claimKey of claimKeys) {
      const data = await client.get(claimKey);
      if (!data) continue;

      try {
        const claim = JSON.parse(data) as Claim;
        if (claim.agentId === agentId) {
          await client.del(claimKey);
        }
      } catch {
        // Malformed claim - delete it
        await client.del(claimKey);
      }
    }
  }

  /**
   * Remove agent status from Redis
   */
  async function removeAgentStatus(): Promise<void> {
    if (!connected || !projectHash || !agentId) {
      return;
    }

    const redis = getRedisClient();
    const client = redis.getClient();
    const agentKey = `opencode:${projectHash}:agent:${agentId}`;

    await client.del(agentKey);
  }

  /**
   * Get current status of this agent
   */
  async function getCurrentStatus(): Promise<AgentStatus | null> {
    if (!connected || !projectHash || !agentId) {
      return null;
    }

    const redis = getRedisClient();
    const client = redis.getClient();
    const agentKey = `opencode:${projectHash}:agent:${agentId}`;

    const data = await client.get(agentKey);
    if (!data) return null;

    try {
      return JSON.parse(data) as AgentStatus;
    } catch {
      return null;
    }
  }

  // Initialize heartbeat on plugin creation
  startHeartbeat().catch((error) => {
    console.warn('[AgentBus] Failed to start heartbeat:', error);
  });

  // Build tool definitions (placeholder - actual tools loaded from ./tools)
  const tools: ToolDefinition[] = [];

  // Return plugin hooks
  return {
    tool: tools,

    /**
     * Compaction hook - inject coordination context
     *
     * Called by OpenCode during context compaction. Provides:
     * - List of active agents with their status
     * - Recent messages from subscribed channels
     * - File claims held by this agent
     */
    'experimental.session.compacting': async (
      _input: CompactionInput,
      output: CompactionOutput
    ): Promise<void> => {
      // Skip if not connected
      if (!connected) {
        return;
      }

      // Check if heartbeat manager exists
      if (!heartbeatManager) {
        return;
      }

      // Get current status for heartbeat state
      const currentStatus = await getCurrentStatus();
      if (currentStatus) {
        heartbeatManager.updateState({
          task: currentStatus.task,
          files: currentStatus.files,
          claimedFiles: currentStatus.claimedFiles,
          channels: currentStatus.channels,
        });
      }

      // Fetch coordination data in parallel
      const [agents, myClaims, recentMessages] = await Promise.all([
        getActiveAgents(),
        getMyClaims(),
        getRecentMessages(['general', 'claims'], 5),
      ]);

      // Format and inject context
      const contextText = formatCompactionContext(agents, myClaims, recentMessages);
      output.context.push(contextText);
    },

    /**
     * Event handler - cleanup on session events
     */
    event: async (payload: PluginEvent): Promise<void> => {
      const { event } = payload;

      switch (event.type) {
        case 'session.idle':
        case 'session.end':
          // Stop heartbeat first
          await stopHeartbeat();

          if (connected) {
            // Remove agent status
            await removeAgentStatus();

            // Release all claims
            await releaseAllClaims();
          }

          connected = false;
          break;

        default:
          // Unknown event type - ignore
          break;
      }
    },
  };
}

// Export plugin factory
export type { AgentBusPlugin };
