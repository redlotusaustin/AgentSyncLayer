/**
 * bus_history tool - Read paginated message history from SQLite
 *
 * Provides deep access to message history beyond what bus_read returns,
 * with pagination support for efficient scrolling through large histories.
 *
 * Tool: bus_history
 * Purpose: Paginated deep history reads from SQLite
 *
 * Fallback: If SQLite is unavailable, returns SQLITE_UNAVAILABLE error.
 * Pagination: Uses page number (1-indexed) and per_page count.
 */
import { getSqliteClient } from '../sqlite';
import { resolveProjectHash, resolveDbDir } from '../config';
import { validateChannel, validateLimit, ValidationException } from '../validation';
import { getSessionAgentId } from '../session';
import { updateLastSeenTimestamp } from './notifications';
import type {
  ToolContext,
  ToolResponse,
  HistoryResponseData,
} from '../types';

/**
 * Tool arguments for bus_history.
 *
 * @example
 * // Read first page of 'general' channel
 * { channel: 'general', page: 1, per_page: 50 }
 *
 * // Read page 3 of all channels, 20 per page
 * { page: 3, per_page: 20 }
 */
export interface BusHistoryArgs {
  /** Channel to filter by (omit for all channels) */
  channel?: string;
  /** Page number (1-indexed, default: 1) */
  page?: number;
  /** Messages per page (default: 50, max: 100) */
  per_page?: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 50;

/**
 * Execute bus_history: read paginated message history from SQLite.
 *
 * @param args - Tool arguments (channel, page, per_page)
 * @param context - Tool context (directory)
 * @returns Response with paginated messages and pagination metadata
 *
 * @example
 * const result = await busHistoryExecute(
 *   { channel: 'general', page: 2, per_page: 50 },
 *   { directory: '/path/to/project' }
 * );
 * // Returns: { ok: true, data: { messages, count, total, page, per_page, total_pages } }
 */
export async function busHistoryExecute(
  args: BusHistoryArgs,
  context: ToolContext
): Promise<ToolResponse<HistoryResponseData>> {
  const projectHash = resolveProjectHash(context.directory);

  try {
    // Validate and clamp inputs
    const channel = args.channel ? validateChannel(args.channel) : null;
    const page = Math.max(1, args.page ?? DEFAULT_PAGE);
    const perPage = validateLimit(args.per_page ?? DEFAULT_PER_PAGE);
    const offset = (page - 1) * perPage;

    // Get SQLite client
    const sqlite = getSqliteClient(resolveDbDir(context.directory), projectHash);
    if (!sqlite) {
      return {
        ok: false,
        error: 'SQLite unavailable: history database not initialized',
        code: 'SQLITE_UNAVAILABLE',
      };
    }

    // Query messages with pagination
    const { messages, total } = sqlite.getMessages({
      projectHash,
      channel,
      limit: perPage,
      offset,
    });

    const totalPages = Math.ceil(total / perPage);

    // Update last-seen timestamp (fire-and-forget)
    const agentId = getSessionAgentId();
    await updateLastSeenTimestamp(projectHash, agentId).catch(() => {});

    return {
      ok: true,
      data: {
        messages,
        count: messages.length,
        total,
        page,
        per_page: perPage,
        total_pages: totalPages,
      },
    };
  } catch (error) {
    if (error instanceof ValidationException) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
      };
    }

    console.error('[bus_history] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
