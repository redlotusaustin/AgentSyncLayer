/**
 * Configuration resolution for AgentSyncLayer
 *
 * Handles resolution of bus identity configuration from multiple sources:
 * 1. Environment variable: AGENTSYNCLAYER_BUS_ID (highest priority)
 * 2. Config file: .agentsynclayer.json (in current directory only)
 * 3. Default: use cwd as bus identity (lowest priority)
 *
 * The resolved configuration determines:
 * - bus_dir: Directory used for project hash computation (Redis namespace)
 * - db_dir: Directory where .agentsynclayer/history.db is stored
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
 * // Both directories specified
 * { "bus": ".", "db": "/shared/data" }
 */
export interface AgentSyncLayerConfigFile {
  /** Directory for project hash (defaults to config file's directory) */
  bus?: string;
  /** Directory for SQLite database (defaults to bus value) */
  db?: string;
}

/**
 * Resolved bus configuration for a project directory.
 *
 * @example
 * // From environment variable
 * { bus_dir: '/shared/workspace', db_dir: '/shared/workspace', projectHash: 'a1b2c3d4e5f6', source: 'env', configPath: null }
 *
 * // From config file
 * { bus_dir: '/mono', db_dir: '/mono', projectHash: 'f7e8d9c0b1a2', source: 'config', configPath: '/mono/.agentsynclayer.json' }
 *
 * // From default (no config)
 * { bus_dir: '/project', db_dir: '/project', projectHash: '123456789abc', source: 'default', configPath: null }
 */
export interface BusConfig {
  /** Directory used for project hash computation (Redis key prefix) */
  bus_dir: string;
  /** Directory where .agentsynclayer/history.db is stored */
  db_dir: string;
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
 * Resolution order:
 * 1. AGENTSYNCLAYER_BUS_ID environment variable (highest priority)
 * 2. .agentsynclayer.json file in current directory only (no ancestor walk)
 * 3. Default: use cwd as bus identity
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

  // Phase 1: Check environment variable
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
 * Attempt to resolve config from AGENTSYNCLAYER_BUS_ID environment variable.
 *
 * @returns BusConfig if env var is set and valid, null otherwise
 */
function resolveFromEnv(): BusConfig | null {
  const envValue = process.env.AGENTSYNCLAYER_BUS_ID;
  if (!envValue) {
    return null;
  }

  try {
    const busDir = fs.realpathSync(envValue);

    // Validate it's a directory
    if (!fs.statSync(busDir).isDirectory()) {
      console.warn('[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID is not a directory:', envValue);
      return null;
    }

    // db_dir is same as bus_dir when using env var
    const dbDir = busDir;

    // Validate db_dir is creatable (mkdir -p will create it)
    try {
      fs.mkdirSync(dbDir, { recursive: true });
    } catch {
      console.warn('[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID db_dir is not creatable:', dbDir);
      return null;
    }

    return {
      bus_dir: busDir,
      db_dir: dbDir,
      projectHash: hashProjectPath(busDir),
      source: 'env',
      configPath: null,
    };
  } catch {
    console.warn('[AgentSyncLayer] AGENTSYNCLAYER_BUS_ID path could not be resolved:', envValue);
    return null;
  }
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

  if (fs.existsSync(configPath)) {
    try {
      return parseConfig(configPath, canonicalCwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[AgentSyncLayer] Invalid config in:', configPath, message);
    }
  }

  return null;
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
  // Read and parse JSON
  let raw: AgentSyncLayerConfigFile;
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content);
  } catch (error) {
    console.warn(
      '[AgentSyncLayer] Failed to read/parse config file:',
      configPath,
      error instanceof Error ? error.message : String(error),
    );
    throw new Error('Failed to parse config');
  }

  // Resolve bus_dir (default: configDir)
  const busRelative = raw.bus ?? '.';
  let busDir: string;
  try {
    if (path.isAbsolute(busRelative)) {
      busDir = fs.realpathSync(busRelative);
    } else {
      busDir = fs.realpathSync(path.join(configDir, busRelative));
    }
  } catch {
    console.warn('[AgentSyncLayer] Config bus directory could not be resolved:', busRelative);
    throw new Error('Invalid bus directory');
  }

  // Validate bus_dir is a directory
  try {
    if (!fs.statSync(busDir).isDirectory()) {
      console.warn('[AgentSyncLayer] Config bus is not a directory:', busDir);
      throw new Error('bus is not a directory');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'bus is not a directory') {
      throw error;
    }
    console.warn('[AgentSyncLayer] Config bus directory does not exist:', busDir);
    throw new Error('bus directory does not exist');
  }

  // Resolve db_dir (default: same relative value as bus)
  const dbRelative = raw.db ?? raw.bus ?? '.';
  let dbDir: string;
  try {
    if (path.isAbsolute(dbRelative)) {
      dbDir = fs.realpathSync(dbRelative);
    } else {
      dbDir = fs.realpathSync(path.join(configDir, dbRelative));
    }
  } catch {
    console.warn('[AgentSyncLayer] Config db directory could not be resolved:', dbRelative);
    throw new Error('Invalid db directory');
  }

  // Warn if either db_dir or bus_dir is outside the project tree (trust model)
  const dbOutside = !dbDir.startsWith(configDir);
  const busOutside = !busDir.startsWith(configDir);
  if (dbOutside || busOutside) {
    const outside = [];
    if (dbOutside) outside.push('db_dir');
    if (busOutside) outside.push('bus_dir');
    console.warn(
      `[AgentSyncLayer] ${outside.join(' and ')} ${outside.length === 1 ? 'is' : 'are'} outside the project tree. This may indicate a misconfiguration or intentional cross-project shared bus.`,
    );
  }

  // Ensure db_dir is creatable
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {
    console.warn('[AgentSyncLayer] Config db directory is not creatable:', dbDir);
    throw new Error('db directory is not creatable');
  }

  return {
    bus_dir: busDir,
    db_dir: dbDir,
    projectHash: hashProjectPath(busDir),
    source: 'config',
    configPath: path.resolve(configPath),
  };
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
