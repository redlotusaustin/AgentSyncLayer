/**
 * bus_info tool - Get AgentSyncLayer configuration info
 *
 * Returns the resolved bus configuration for the current project.
 */

import { resolveBusConfig } from '../config';
import type { ToolContext, ToolResponse, BusInfoResponseData } from '../types';

/**
 * Execute bus_info: return bus configuration info
 *
 * @param _args - Tool arguments (none)
 * @param context - Tool context (directory)
 * @returns Response with bus configuration
 */
export async function busInfoExecute(
  _args: Record<string, never>,
  context: ToolContext
): Promise<ToolResponse<BusInfoResponseData>> {
  try {
    const config = resolveBusConfig(context.directory);
    return {
      ok: true,
      data: {
        projectHash: config.projectHash,
        bus_dir: config.bus_dir,
        db_dir: config.db_dir,
        source: config.source,
        configPath: config.configPath,
      },
    };
  } catch (error) {
    console.error('[bus_info] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
