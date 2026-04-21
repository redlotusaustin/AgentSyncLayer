/**
 * Configuration resolution for AgentSyncLayer
 *
 * Handles resolution of bus identity configuration from multiple sources:
 * 1. Environment variables (highest priority)
 * 2. Config file: .agentsynclayer.json (in current directory only)
 * 3. Default: use cwd as bus identity (lowest priority)
 *
 * Per-field precedence: each option resolved independently.
 * Example: AGENTSYNCLAYER_REDIS_URL + config file for bus + default db -> env redis + config bus + default db
 *
 * The resolved configuration determines:
 * - bus_dir: Directory used for project hash computation (Redis namespace)
 * - db_dir: Directory where .agentsynclayer/history.db is stored
 * - redis_url: Redis connection URL (for Redis client)
 * - projectHash: 12-character hex hash of bus_dir
 * - source: How the config was resolved ('env', 'config', or 'default')
 * - configPath: Absolute path to .agentsynclayer.json if found, null otherwise
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { hashProjectPath } from './namespace';

/**
 * Interface for the .agentsynclayer.json config file schema.
 *
 * @example
 * // Minimal config (all defaults)
 * {}
 *
 * // Bus directory specified
 * { "bus": "." }
 *
 * // All options specified
 * { "bus": ".", "db": "/shared/data", "redis": "redis://custom:6379" }
 */
export interface AgentSyncLayerConfigFile {
  /** Directory for project hash (defaults to config file's directory) */
  bus?: string;
  /** Directory for SQLite database (defaults to bus value) */
  db?: string;
  /** Redis connection URL (defaults to redis://localhost:6379) */
  redis?: string;
}

/**
 * Resolved bus configuration for a project directory.
 *
 * @example
 * // From environment variable
 * { bus_dir: '/shared/workspace', db_dir: '/shared/workspace', redis_url: 'redis://custom:6379', projectHash: 'a1b2c3d4e5f6', source: 'env', configPath: null }
 *
 * // From config file
 * { bus_dir: '/mono', db_dir: '/mono', redis_url: 'redis://share:6379', projectHash: 'f7e8d9c0b1a2', source: 'config', configPath: '/mono/.agentsynclayer.json' }
 *
 * // From default (no config)
 * { bus_dir: '/project', db_dir: '/project', redis_url: 'redis://localhost:6379', projectHash: '123456789abc', source: 'default', configPath: null }
 */
export interface BusConfig {
  /** Directory used for project hash computation (Redis key prefix) */
  bus_dir: string;
  /** Directory where .agentsynclayer/history.db is stored */
  db_dir: string;
  /** Redis connection URL */
  redis_url: string;
  /** 12-character hex project hash: hashProjectPath(bus_dir) */
  projectHash: string;
  /** How the config was resolved */
  source: 'env' | 'config' | 'default';
  /** Absolute path to the .agentsynclayer.json file, or null if not found */
  configPath: string | null;
}

/** Module-level cache: canonical cwd -> BusConfig */
const configCache = new Map<string, BusConfig>();

/**
 * Reset the config cache (for testing only).
 *
 * Clears all cached configurations so that subsequent calls to
 * resolveBusConfig() will re-resolve from scratch.
 *
 * @example
 * // After modifying config files during tests
 * resetBusConfig();
 */
export function resetBusConfig(): void {
  configCache.clear();
}

/**
 * Resolve bus configuration for a given working directory.
 *
 * Resolution order (per-field precedence):
 * Each field is resolved independently:
 * - AGENTSYNCLAYER_REDIS_URL > redis key > default
 * - AGENTSYNCLAYER_BUS_ID > bus key > default
 * - AGENTSYNCLAYER_DB_DIR > db key > default
 *
 * Results are cached per canonical cwd. Subsequent calls return
 * the cached result without re-resolving.
 *
 * @param cwd - The current working directory to resolve config for
 * @returns The resolved BusConfig
 *
 * @example
 * const config = resolveBusConfig('/home/user/project');
 * console.log(config.projectHash); // e.g., 'a1b2c3d4e5f6'
 * console.log(config.redis_url);     // e.g., 'redis://localhost:6379'
 * console.log(config.source);      // 'config', 'env', or 'default'
 */
export function resolveBusConfig(cwd: string): BusConfig {
  // Normalize cwd to canonical path
  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    console.warn('[AgentSyncLayer] Failed to resolve realpath of cwd, using as-is:', cwd);
    canonicalCwd = cwd;
  }

  // Return cached result if available
  const cached = configCache.get(canonicalCwd);
  if (cached) {
    return cached;
  }

  let config: BusConfig | null;

  // Phase 1: Check environment variables (highest priority for each field)
  config = resolveFromEnv();
  if (config) {
    configCache.set(canonicalCwd, config);
    return config;
  }

  // Phase 2: Check for config in current directory only
  config = resolveFromLocalConfig(canonicalCwd);
  if (config) {
    configCache.set(canonicalCwd, config);
    return config;
  }

  // Phase 3: Default (use cwd as bus identity)
  config = resolveToDefault(canonicalCwd);
  configCache.set(canonicalCwd, config);
  return config;
}

/**
 * Attempt to resolve config from environment variables.
 *
 * Checks AGENTSYNCLAYER_REDIS_URL, AGENTSYNCLAYER_BUS_ID, and AGENTSYNCLAYER_DB_DIR.
 * Returns config with source: 'env' if ANY of these env vars is set.
 *
 * @returns BusConfig if any env var is set, null otherwise
 */
function resolveFromEnv(): BusConfig | null {
  const hasRedis = 'AGENTSYNCLAYER_REDIS_URL' in process.env;
  const hasBus = 'AGENTSYNCLAYER_BUS_ID' in process.env;
  const hasDb = 'AGENTSYNCLAYER_DB_DIR' in process.env;

  if (!hasRedis && !hasBus && !hasDb) {
    return null;
  }

  // Resolve redis_url from env (if set)
  let redisUrl: string | null = null;
  if (hasRedis) {
    const envRedis = process.env.AGENTSYNCLAYER_REDIS_URL;
    if (envRedis && isValidRedisUrl(envRedis)) {
      redisUrl = envRedis;
      console.warn('[AgentSyncLayer] AGENTSYNCLAYER_REDIS_URL resolved to:', redisUrl);
    } else if (envRedis) {
      console.warn('[AgentSyncLayer] AGENTSYNCLAYER_REDIS_URL is invalid:', envRedis);
    }
  }

  // Resolve bus_dir from env (if set)
  let busDir: string | null = null;
  if (hasBus) {
    const envBus = process.env.AGENTSYNCLAYER_BUS_ID;
    if (envBus) {
      try {
        busDir = fs.realpathSync(envBus);
        if (!fs.statSync(busDir).isDirectory()) {
          console.warn('[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID is not a directory:', envBus);
          busDir = null;
        } else {
          // Validate bus_dir is creatable
          try {
            fs.mkdirSync(busDir, { recursive: true });
          } catch {
            console.warn(
              '[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID directory is not creatable:',
              busDir,
            );
            busDir = null;
          }
        }
        if (busDir) {
          console.warn('[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID resolved to:', busDir);
        }
      } catch {
        console.warn('[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID path could not be resolved:', envBus);
        busDir = null;
      }
    }
  }

  // Resolve db_dir from env (if set)
  let dbDir: string | null = null;
  if (hasDb) {
    const envDb = process.env.AGENTSYNCLAYER_DB_DIR;
    if (envDb) {
      try {
        dbDir = fs.realpathSync(envDb);
        if (!fs.statSync(dbDir).isDirectory()) {
          console.warn('[AgentSyncLayer] AGENTSYNCLAYER_DB_DIR is not a directory:', envDb);
          dbDir = null;
        } else {
          // Validate db_dir is creatable
          try {
            fs.mkdirSync(dbDir, { recursive: true });
          } catch {
            console.warn(
              '[AgentSyncLayer] AGENTSYNCLAYER_DB_DIR directory is not creatable:',
              dbDir,
            );
            dbDir = null;
          }
        }
        if (dbDir) {
          console.warn('[AgentSyncLayer] AGENTSYNCLAYER_DB_DIR resolved to:', dbDir);
        }
      } catch {
        console.warn('[AgentSyncLayer] AGENTSYNCLAYER_DB_DIR path could not be resolved:', envDb);
        dbDir = null;
      }
    }
  }

  // If any env var is set but none resolved successfully, still return null
  // to allow fallback to config file or default
  if (!hasRedis && !hasBus && !hasDb) {
    return null;
  }

  // At this point, we have at least one env var set (even if resolution failed)
  // But we need at least ONE field to come from env to return env-sourced config
  // If ALL resolution attempts failed, return null to fall back
  if (!redisUrl && !busDir && !dbDir) {
    return null;
  }

  // If some fields resolved from env but others didn't, we need to get defaults for the rest
  // Use current working directory as default basis
  const cwd = process.cwd();
  const defaultConfig = resolveToDefault(cwd);

  return {
    bus_dir: busDir ?? defaultConfig.bus_dir,
    db_dir: dbDir ?? defaultConfig.db_dir,
    redis_url: redisUrl ?? defaultConfig.redis_url,
    projectHash: hashProjectPath(busDir ?? defaultConfig.bus_dir),
    source: 'env',
    configPath: null,
  };
}

/**
 * Check for .agentsynclayer.json in the current directory only.
 *
 * Does NOT walk up the directory tree (no ancestor walk).
 *
 * @param canonicalCwd - Canonical current working directory
 * @returns BusConfig if config file found and valid, null otherwise
 */
function resolveFromLocalConfig(canonicalCwd: string): BusConfig | null {
  const configPath = path.join(canonicalCwd, '.agentsynclayer.json');
  try {
    return parseConfig(configPath, canonicalCwd);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EACCES'
    ) {
      console.warn(`[AgentSyncLayer] Permission denied reading config: ${configPath}`);
    }
    return null;
  }
}

/**
 * Validate and parse a .agentsynclayer.json config file object.
 *
 * Allows 'bus', 'db', and 'redis' keys (strict mode).
 *
 * @param raw - Parsed JSON value from the config file
 * @returns Validated config object
 * @throws Error if validation fails
 */
function validateConfigFile(raw: unknown): AgentSyncLayerConfigFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set(['bus', 'db', 'redis']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown key: ${key}`);
    }
    if (obj[key] !== undefined && typeof obj[key] !== 'string') {
      throw new Error(`Key "${key}" must be a string`);
    }
  }
  return {
    bus: typeof obj.bus === 'string' ? obj.bus : undefined,
    db: typeof obj.db === 'string' ? obj.db : undefined,
    redis: typeof obj.redis === 'string' ? obj.redis : undefined,
  };
}

/**
 * Parse a .agentsynclayer.json config file.
 *
 * @param configPath - Absolute path to the config file
 * @param configDir - Directory containing the config file
 * @returns Parsed BusConfig
 * @throws Error if parsing fails or paths are invalid
 */
function parseConfig(configPath: string, configDir: string): BusConfig {
  // Read, validate, and parse JSON
  let raw: AgentSyncLayerConfigFile;
  try {
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    raw = validateConfigFile(JSON.parse(fileContent));
  } catch (error) {
    // ENOENT is the normal case (no config file) — skip logging
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Failed to parse config');
    }
    console.warn(
      '[AgentSyncLayer] Invalid config file:',
      configPath,
      error instanceof Error ? error.message : String(error),
    );
    throw new Error('Failed to parse config');
  }

  // Resolve bus_dir (default: configDir)
  const busRelative = raw.bus ?? '.';
  let busDir: string;
  try {
    busDir = path.isAbsolute(busRelative)
      ? fs.realpathSync(busRelative)
      : fs.realpathSync(path.join(configDir, busRelative));
  } catch {
    console.warn('[AgentSyncLayer] Config bus directory could not be resolved:', busRelative);
    throw new Error('Invalid bus directory');
  }

  // Validate bus_dir is a directory
  if (!fs.statSync(busDir).isDirectory()) {
    console.warn('[AgentSyncLayer] Config bus is not a directory:', busDir);
    throw new Error('bus is not a directory');
  }

  // Resolve db_dir (default: same relative value as bus)
  const dbRelative = raw.db ?? raw.bus ?? '.';
  let dbDir: string;
  try {
    dbDir = path.isAbsolute(dbRelative)
      ? fs.realpathSync(dbRelative)
      : fs.realpathSync(path.join(configDir, dbRelative));
  } catch {
    console.warn('[AgentSyncLayer] Config db directory could not be resolved:', dbRelative);
    throw new Error('Invalid db directory');
  }

  // Ensure db_dir is creatable
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {
    console.warn('[AgentSyncLayer] Config db directory is not creatable:', dbDir);
    throw new Error('db directory is not creatable');
  }

  // Resolve redis_url (default: standard localhost)
  let redisUrl = 'redis://localhost:6379';
  if (raw.redis) {
    if (isValidRedisUrl(raw.redis)) {
      redisUrl = raw.redis;
    } else {
      console.warn('[AgentSyncLayer] Config redis URL is invalid:', raw.redis);
      throw new Error('redis must be a valid Redis URL (redis:// or rediss://)');
    }
  }

  return {
    bus_dir: busDir,
    db_dir: dbDir,
    redis_url: redisUrl,
    projectHash: hashProjectPath(busDir),
    source: 'config',
    configPath: path.resolve(configPath),
  };
}

/**
 * Validate a Redis URL (must start with redis:// or rediss://).
 *
 * @param url - URL to validate
 * @returns true if valid Redis URL
 */
function isValidRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'redis:' || parsed.protocol === 'rediss:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

/**
 * Resolve to default configuration using cwd as bus identity.
 *
 * @param canonicalCwd - Canonical current working directory
 * @returns Default BusConfig
 */
function resolveToDefault(canonicalCwd: string): BusConfig {
  return {
    bus_dir: canonicalCwd,
    db_dir: canonicalCwd,
    redis_url: 'redis://localhost:6379',
    projectHash: hashProjectPath(canonicalCwd),
    source: 'default',
    configPath: null,
  };
}

/**
 * Get the project hash for a given working directory.
 *
 * Convenience function that resolves the bus config and returns its projectHash.
 * This is a drop-in replacement for hashProjectPath(directory) in tool execute functions.
 *
 * @param cwd - The current working directory
 * @returns 12-character hex project hash
 *
 * @example
 * const hash = resolveProjectHash('/home/user/project');
 * // Returns: 'a1b2c3d4e5f6'
 */
export function resolveProjectHash(cwd: string): string {
  return resolveBusConfig(cwd).projectHash;
}

/**
 * Get the database directory for a given working directory.
 *
 * Convenience function that resolves the bus config and returns its db_dir.
 * Used by tools that access SQLite to get the correct DB directory.
 *
 * @param cwd - The current working directory
 * @returns Absolute path to the DB directory
 *
 * @example
 * const dbDir = resolveDbDir('/home/user/project');
 * // Returns: '/home/user/project'
 */
export function resolveDbDir(cwd: string): string {
  return resolveBusConfig(cwd).db_dir;
}

/**
 * Get the Redis connection URL for a given working directory.
 *
 * Convenience function that resolves the bus config and returns its redis_url.
 * Used by tools that need Redis connection URLs.
 *
 * @param cwd - The current working directory
 * @returns Redis connection URL
 *
 * @example
 * const redisUrl = resolveRedisUrl('/home/user/project');
 * // Returns: 'redis://localhost:6379'
 */
export function resolveRedisUrl(cwd: string): string {
  return resolveBusConfig(cwd).redis_url;
}
