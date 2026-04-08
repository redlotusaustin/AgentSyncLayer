/**
 * AgentBus Plugin Entry Point
 * 
 * Re-exports the adapter as the main entry point.
 * OpenCode loads plugins via the Plugin type from @opencode-ai/plugin.
 * 
 * This file exists for backward compatibility and external imports.
 * The canonical plugin file is ./adapter.ts.
 */

export { AgentBusPlugin as default } from './adapter';
export { AgentBusPlugin } from './adapter';

// Re-export tool implementations for external use
export {
  busSendExecute,
  busReadExecute,
  busChannelsExecute,
  busStatusExecute,
  busAgentsExecute,
  busInfoExecute,
  busClaimExecute,
  busReleaseExecute,
  busListenExecute,
  busHistoryExecute,
  busSearchExecute,
  cleanupRateLimiter,
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
  BusInfoResponseData,
  ClaimResponseData,
  ReleaseResponseData,
  ListenResponseData,
  HistoryResponseData,
  SearchResponseData,
  SearchResult,
} from './types';

// Re-export tool argument types
export type { BusHistoryArgs, BusSearchArgs } from './tools';
