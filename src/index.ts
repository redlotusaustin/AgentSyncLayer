/**
 * AgentSyncLayer Plugin Entry Point
 *
 * Re-exports the adapter as the main entry point.
 * OpenCode loads plugins via the Plugin type from @opencode-ai/plugin.
 *
 * This file exists for backward compatibility and external imports.
 * The canonical plugin file is ./adapter.ts.
 */

export { AgentSyncLayerPlugin as default, AgentSyncLayerPlugin } from './adapter';
// Re-export tool argument types
export type { BusHistoryArgs, BusSearchArgs } from './tools';
// Re-export tool implementations for external use
export {
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
// Re-export types
export type {
  AgentStatus,
  AgentsResponseData,
  BusInfoResponseData,
  ChannelsResponseData,
  Claim,
  ClaimResponseData,
  HistoryResponseData,
  ListenResponseData,
  Message,
  ReadResponseData,
  ReleaseResponseData,
  SearchResponseData,
  SearchResult,
  SendResponseData,
  StatusResponseData,
  ToolResponse,
} from './types';
