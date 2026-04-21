/**
 * Default Behavior Tests (I3)
 *
 * Tests that the default behavior (no config, no env var)
 * is identical to pre-v0.3.0 behavior.
 *
 * Tests: I3.1
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetBusConfig, resolveBusConfig } from '../../src/config';
import { hashProjectPath } from '../../src/namespace';
import { setSessionAgentId } from '../../src/session';
import { closeSqliteClient, getSqliteClient } from '../../src/sqlite';
import { busReadExecute, busSendExecute, cleanupRateLimiter } from '../../src/tools';
import { createTestContext, generateTestAgentId, isRedisAvailable } from '../helpers';

/**
 * Create a clean test directory with no config files
 */
function createCleanTestDir(): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-clean-'));

  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe('I3: Default Behavior', () => {
  const ctx = createTestContext();
  let originalEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Please start Redis server on localhost:6379');
    }
    await ctx.setup();

    // Save original env
    originalEnv = { ...process.env };
  });

  afterAll(async () => {
    // Restore original env
    process.env = originalEnv;
    resetBusConfig();
    cleanupRateLimiter();
    await ctx.teardown();
  });

  beforeEach(() => {
    resetBusConfig();
    // Ensure no env var is set
    delete process.env.AGENTSYNCLAYER_BUS_DIR;
  });

  afterEach(() => {
    resetBusConfig();
    process.env = originalEnv;
    setSessionAgentId(null);
  });

  describe('I3.1: No config behaves like pre-v0.3.0', () => {
    test('agent with no config uses cwd for projectHash', () => {
      const { dir, cleanup } = createCleanTestDir();

      try {
        // Verify no config files exist
        expect(fs.existsSync(path.join(dir, '.agentsynclayer.json'))).toBe(false);

        // Resolve config for this directory
        const config = resolveBusConfig(dir);

        // Should use default behavior
        expect(config.source).toBe('default');
        expect(config.configPath).toBeNull();

        // bus_dir and db_dir should both be the cwd
        expect(config.bus_dir).toBe(dir);
        expect(config.db_dir).toBe(dir);

        // projectHash should be based on cwd
        expect(config.projectHash).toBe(hashProjectPath(dir));
      } finally {
        cleanup();
      }
    });

    test('agent with no config stores SQLite DB at cwd/.agentsynclayer/history.db', () => {
      const { dir, cleanup } = createCleanTestDir();

      try {
        // Get project hash for this directory
        const projectHash = hashProjectPath(dir);
        const expectedDbPath = path.join(dir, '.agentsynclayer', 'history.db');

        // Verify DB doesn't exist yet
        expect(fs.existsSync(expectedDbPath)).toBe(false);

        // Get SQLite client (this creates the DB)
        const sqlite = getSqliteClient(dir, projectHash);
        expect(sqlite).not.toBeNull();

        // Verify DB was created at correct path
        expect(fs.existsSync(expectedDbPath)).toBe(true);
        expect(sqlite!.getDbPath()).toBe(expectedDbPath);

        // DB dir should be {cwd}/.agentsynclayer
        const agentsynclayerDir = path.join(dir, '.agentsynclayer');
        expect(fs.existsSync(agentsynclayerDir)).toBe(true);

        // Clean up
        closeSqliteClient(dir);
      } finally {
        cleanup();
      }
    });

    test('messages sent without config are stored with correct projectHash', async () => {
      const { dir, cleanup } = createCleanTestDir();

      try {
        // Send a message from this directory
        const agentId = generateTestAgentId('default');
        setSessionAgentId(agentId);

        const sendResult = await busSendExecute(
          { channel: 'general', message: 'Message without config' },
          { directory: dir },
        );

        expect(sendResult.ok).toBe(true);

        // Verify projectHash is based on dir
        const config = resolveBusConfig(dir);
        expect(config.projectHash).toBe(hashProjectPath(dir));

        // Read messages and verify project matches
        const readResult = await busReadExecute(
          { channel: 'general', limit: 10 },
          { directory: dir },
        );

        expect(readResult.ok).toBe(true);
        const ourMessage = readResult.data!.messages.find((m) => m.from === agentId);
        expect(ourMessage).toBeDefined();
        expect(ourMessage!.project).toBe(config.projectHash);
      } finally {
        cleanup();
      }
    });

    test('different directories have different projectHashes by default', () => {
      const { dir: dir1, cleanup: cleanup1 } = createCleanTestDir();
      const { dir: dir2, cleanup: cleanup2 } = createCleanTestDir();

      try {
        const config1 = resolveBusConfig(dir1);
        const config2 = resolveBusConfig(dir2);

        // Different directories should have different projectHashes
        expect(config1.projectHash).not.toBe(config2.projectHash);

        // Both should use default source
        expect(config1.source).toBe('default');
        expect(config2.source).toBe('default');

        // Both should have no config path
        expect(config1.configPath).toBeNull();
        expect(config2.configPath).toBeNull();
      } finally {
        cleanup1();
        cleanup2();
      }
    });

    test('config cache is bypassed when calling resolveBusConfig with different directories', () => {
      const { dir: dir1, cleanup: cleanup1 } = createCleanTestDir();
      const { dir: dir2, cleanup: cleanup2 } = createCleanTestDir();

      try {
        // Resolve for dir1
        const config1 = resolveBusConfig(dir1);

        // Resolve for dir2 - should NOT return cached value from dir1
        const config2 = resolveBusConfig(dir2);

        // Different configs
        expect(config1.projectHash).not.toBe(config2.projectHash);
        expect(config1.bus_dir).toBe(dir1);
        expect(config2.bus_dir).toBe(dir2);
      } finally {
        cleanup1();
        cleanup2();
      }
    });

    test('agent with no config has isolated bus from other directories', async () => {
      const { dir: dir1, cleanup: cleanup1 } = createCleanTestDir();
      const { dir: dir2, cleanup: cleanup2 } = createCleanTestDir();

      try {
        const agent1Id = generateTestAgentId('isolated1');
        const agent2Id = generateTestAgentId('isolated2');

        // Send from dir1
        setSessionAgentId(agent1Id);
        await busSendExecute(
          { channel: 'general', message: 'Message from dir1' },
          { directory: dir1 },
        );

        // Send from dir2
        setSessionAgentId(agent2Id);
        await busSendExecute(
          { channel: 'general', message: 'Message from dir2' },
          { directory: dir2 },
        );

        // Read from dir1 - should only see dir1's message
        setSessionAgentId(agent1Id);
        const read1 = await busReadExecute({ channel: 'general', limit: 10 }, { directory: dir1 });

        expect(read1.ok).toBe(true);
        const msg1 = read1.data!.messages.find((m) => m.from === agent1Id);
        const msg2 = read1.data!.messages.find((m) => m.from === agent2Id);
        expect(msg1).toBeDefined();
        expect(msg2).toBeUndefined(); // dir2's message should not be visible

        // Read from dir2 - should only see dir2's message
        setSessionAgentId(agent2Id);
        const read2 = await busReadExecute({ channel: 'general', limit: 10 }, { directory: dir2 });

        expect(read2.ok).toBe(true);
        const msg3 = read2.data!.messages.find((m) => m.from === agent2Id);
        const msg4 = read2.data!.messages.find((m) => m.from === agent1Id);
        expect(msg3).toBeDefined();
        expect(msg4).toBeUndefined(); // dir1's message should not be visible
      } finally {
        cleanup1();
        cleanup2();
      }
    });
  });
});
