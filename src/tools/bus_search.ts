/**
 * bus_search tool - Full-text search of message history via FTS5
 *
 * Uses SQLite FTS5 for efficient full-text search across message payloads,
 * with relevance ranking and snippet extraction.
 *
 * Tool: bus_search
 * Purpose: Full-text search across message history using FTS5
 *
 * Features:
 * - Relevance-ranked results
 * - Snippet extraction with context highlighting
 * - Channel filtering
 * - Configurable result limit
 *
 * Fallback: If SQLite is unavailable, returns SQLITE_UNAVAILABLE error.
 */

import { getSqliteClient } from '../sqlite';
import { resolveProjectHash, resolveDbDir } from '../config';
import { validateChannel, validateLimit, ValidationException } from '../validation';
import type {
  ToolContext,
  ToolResponse,
  SearchResponseData,
  SearchResult,
} from '../types';

/**
 * Tool arguments for bus_search.
 *
 * @example
 * // Search all channels for 'authentication'
 * { query: 'authentication', limit: 20 }
 *
 * // Search 'general' channel for 'refactor'
 * { query: 'refactor', channel: 'general', limit: 10 }
 */
export interface BusSearchArgs {
  /** Search query text */
  query: string;
  /** Channel to filter by (omit for all channels) */
  channel?: string;
  /** Maximum number of results (default: 20, max: 100) */
  limit?: number;
}

const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Execute bus_search: search message history with full-text search.
 *
 * @param args - Tool arguments (query, channel, limit)
 * @param context - Tool context (directory)
 * @returns Response with search results and metadata
 *
 * @example
 * const result = await busSearchExecute(
 *   { query: 'authentication', channel: 'general', limit: 20 },
 *   { directory: '/path/to/project' }
 * );
 * // Returns: { ok: true, data: { results, count, query } }
 */
export async function busSearchExecute(
  args: BusSearchArgs,
  context: ToolContext
): Promise<ToolResponse<SearchResponseData>> {
  const projectHash = resolveProjectHash(context.directory);

  try {
    // Validate query is non-empty
    const trimmedQuery = args.query?.trim() ?? '';
    if (trimmedQuery.length === 0) {
      return {
        ok: false,
        error: 'Search query cannot be empty',
        code: 'QUERY_INVALID',
      };
    }

    // Validate and clamp inputs
    const channel = args.channel ? validateChannel(args.channel) : null;
    const limit = validateLimit(args.limit ?? DEFAULT_SEARCH_LIMIT);
    const query = trimmedQuery;

    // Get SQLite client
    const sqlite = getSqliteClient(resolveDbDir(context.directory));
    if (!sqlite) {
      return {
        ok: false,
        error: 'SQLite unavailable: search database not initialized',
        code: 'SQLITE_UNAVAILABLE',
      };
    }

    // Perform FTS5 search
    const rawResults = sqlite.searchMessages(projectHash, query, channel, limit);

    // Transform results to SearchResult format
    const results: SearchResult[] = rawResults.map((r) => ({
      message: r.message,
      rank: r.rank,
      snippet: r.snippet,
    }));

    return {
      ok: true,
      data: {
        results,
        count: results.length,
        query,
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

    console.error('[bus_search] Error:', error);
    return {
      ok: false,
      error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR',
    };
  }
}
