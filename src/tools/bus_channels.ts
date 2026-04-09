/**
 * bus_channels tool - List active channels in the current project
 *
 * Operations:
 * 1. SMEMBERS to get all channel names
 * 2. ZCARD for each channel to get message count
 */

import { getRedisClient } from '../redis';
import { resolveProjectHash } from '../config';
import type {
  ChannelInfo,
  ToolContext,
  ToolResponse,
  ChannelsResponseData,
} from '../types';

/**
 * Execute bus_channels: list active channels with message counts
 *
 * @param _args - Tool arguments (none)
 * @param context - Tool context (directory)
 * @returns Response with channel list
 */
export async function busChannelsExecute(
  _args: Record<string, never>,
  context: ToolContext
): Promise<ToolResponse<ChannelsResponseData>> {
  const redis = getRedisClient();

  // Check Redis connection
  if (!redis.checkConnection()) {
    return {
      ok: false,
      error: 'Bus unavailable: Redis connection not established',
      code: 'BUS_UNAVAILABLE',
    };
  }

  try {
    // Get project hash
    const projectHash = resolveProjectHash(context.directory);
    const channelsKey = `opencode:${projectHash}:channels`;
    const client = redis.getClient();

    // Get all channel names from set
    const channelNames = await client.smembers(channelsKey);

    if (channelNames.length === 0) {
      return {
        ok: true,
        data: {
          channels: [],
          count: 0,
        },
      };
    }

    // Get message count for each channel using pipeline (single round-trip)
    const pipeline = client.pipeline();
    for (const name of channelNames) {
      const historyKey = `opencode:${projectHash}:history:${name}`;
      pipeline.zcard(historyKey);
    }
    const pipelineResults = await pipeline.exec();

    const channelInfos: ChannelInfo[] = channelNames.map((name, index) => ({
      name,
      messages: pipelineResults?.[index]?.[1] ?? 0,
    }));

    // Sort by name for consistent output
    channelInfos.sort((a, b) => a.name.localeCompare(b.name));

    return {
      ok: true,
      data: {
        channels: channelInfos,
        count: channelInfos.length,
      },
    };
  } catch (error) {
    console.error('[bus_channels] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
