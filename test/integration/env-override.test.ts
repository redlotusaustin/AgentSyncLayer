/**
 * Env Var Override Tests (I2)
 *
 * Tests that the AGENTBUS_BUS_ID environment variable overrides
 * .agentbus.json and default behavior correctly.
 *
 * Tests: I2.1-I2.2
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createTestContext,
  isRedisAvailable,
  generateTestAgentId,
} from '../helpers';
import {
  busSendExecute,
  busReadExecute,
  busStatusExecute,
  busAgentsExecute,
  cleanupRateLimiter,
} from '../../src/tools';
import { resetBusConfig, resolveBusConfig, BusConfig } from '../../src/config';
import { hashProjectPath } from '../../src/namespace';
import { getSessionAgentId, setSessionAgentId } from '../../src/session';

/**
 * Create a temp directory with optional .agentbus.json config
 */
function createTestDir(withConfig = false): {
  dir: string;
  sharedDir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-env-'));
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-shared-'));

  if (withConfig) {
    // Create .agentbus.json pointing to the dir itself (would be overridden by env)
    fs.writeFileSync(
      path.join(dir, '.agentbus.json'),
      JSON.stringify({ bus: '.' })
    );
  }

  return {
    dir,
    sharedDir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

describe('I2: Env Var Override', () => {
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
    // Reset config cache
    resetBusConfig();
    // Restore original env before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    resetBusConfig();
    process.env = originalEnv;
    setSessionAgentId(null);
  });

  describe('I2.1: Shared bus via AGENTBUS_BUS_ID', () => {
    test('two agents in different directories share a bus via env var', async () => {
      const { dir: dir1, sharedDir, cleanup: cleanup1 } = createTestDir();
      const { dir: dir2, cleanup: cleanup2 } = createTestDir();

      try {
        // Set AGENTBUS_BUS_ID to shared directory
        process.env.AGENTBUS_BUS_ID = sharedDir;
        resetBusConfig();

        const agent1Id = generateTestAgentId('env1');
        const agent2Id = generateTestAgentId('env2');

        // Agent 1 sends from dir1
        setSessionAgentId(agent1Id);
        const sendResult1 = await busSendExecute(
          { channel: 'general', message: 'Message from agent 1' },
          { directory: dir1 }
        );
        expect(sendResult1.ok).toBe(true);

        // Agent 2 sends from dir2
        setSessionAgentId(agent2Id);
        const sendResult2 = await busSendExecute(
          { channel: 'general', message: 'Message from agent 2' },
          { directory: dir2 }
        );
        expect(sendResult2.ok).toBe(true);

        // Both agents can read both messages
        setSessionAgentId(agent1Id);
        const readResult1 = await busReadExecute(
          { channel: 'general', limit: 10 },
          { directory: dir1 }
        );
        expect(readResult1.ok).toBe(true);
        expect(readResult1.data!.messages.length).toBeGreaterThanOrEqual(2);

        setSessionAgentId(agent2Id);
        const readResult2 = await busReadExecute(
          { channel: 'general', limit: 10 },
          { directory: dir2 }
        );
        expect(readResult2.ok).toBe(true);
        expect(readResult2.data!.messages.length).toBeGreaterThanOrEqual(2);

        // Verify agent 2 can see agent 1's message
        const msgFromAgent1 = readResult2.data!.messages.find(
          (m) => m.from === agent1Id
        );
        expect(msgFromAgent1).toBeDefined();
        expect((msgFromAgent1!.payload as any).text).toBe('Message from agent 1');

        // Verify agent 1 can see agent 2's message
        const msgFromAgent2 = readResult1.data!.messages.find(
          (m) => m.from === agent2Id
        );
        expect(msgFromAgent2).toBeDefined();
        expect((msgFromAgent2!.payload as any).text).toBe('Message from agent 2');
      } finally {
        cleanup1();
        cleanup2();
      }
    });

    test('agents share same projectHash when using env var', () => {
      const { dir: dir1, sharedDir, cleanup: cleanup1 } = createTestDir();
      const { dir: dir2, cleanup: cleanup2 } = createTestDir();

      try {
        // Set AGENTBUS_BUS_ID
        process.env.AGENTBUS_BUS_ID = sharedDir;
        resetBusConfig();

        // Both directories should resolve to the same projectHash
        const config1 = resolveBusConfig(dir1);
        const config2 = resolveBusConfig(dir2);

        expect(config1.projectHash).toBe(config2.projectHash);
        expect(config1.projectHash).toBe(hashProjectPath(sharedDir));

        // Both should have source 'env'
        expect(config1.source).toBe('env');
        expect(config2.source).toBe('env');
        expect(config1.configPath).toBeNull();
        expect(config2.configPath).toBeNull();
      } finally {
        cleanup1();
        cleanup2();
      }
    });

    test('agents see each other in bus_agents when sharing bus', async () => {
      const { dir: dir1, sharedDir, cleanup: cleanup1 } = createTestDir();
      const { dir: dir2, cleanup: cleanup2 } = createTestDir();

      try {
        process.env.AGENTBUS_BUS_ID = sharedDir;
        resetBusConfig();

        const agent1Id = generateTestAgentId('env1');
        const agent2Id = generateTestAgentId('env2');

        // Register both agents
        setSessionAgentId(agent1Id);
        await busStatusExecute(
          { task: 'Task 1', channels: ['general'] },
          { directory: dir1 }
        );

        setSessionAgentId(agent2Id);
        await busStatusExecute(
          { task: 'Task 2', channels: ['general'] },
          { directory: dir2 }
        );

        // Query from agent 1's context
        setSessionAgentId(agent1Id);
        const agentsResult = await busAgentsExecute({}, { directory: dir1 });
        expect(agentsResult.ok).toBe(true);

        const agentIds = agentsResult.data!.agents.map((a) => a.id);
        expect(agentIds).toContain(agent1Id);
        expect(agentIds).toContain(agent2Id);
      } finally {
        cleanup1();
        cleanup2();
      }
    });
  });

  describe('I2.2: Env var ignores .agentbus.json in CWD', () => {
    test('agent with env var ignores .agentbus.json in CWD', () => {
      const { dir: cwd, sharedDir, cleanup: cleanup1 } = createTestDir(true);
      const { cleanup: cleanup2 } = createTestDir();

      try {
        // Create .agentbus.json in cwd pointing to cwd
        // But set AGENTBUS_BUS_ID to different directory
        process.env.AGENTBUS_BUS_ID = sharedDir;
        resetBusConfig();

        // Resolving from cwd should use env var, not .agentbus.json
        const config = resolveBusConfig(cwd);

        expect(config.source).toBe('env');
        expect(config.bus_dir).toBe(sharedDir);
        expect(config.db_dir).toBe(sharedDir);
        expect(config.configPath).toBeNull();

        // Project hash should be based on sharedDir, not cwd
        expect(config.projectHash).toBe(hashProjectPath(sharedDir));
        expect(config.projectHash).not.toBe(hashProjectPath(cwd));
      } finally {
        cleanup1();
        cleanup2();
      }
    });

    test('config file is not consulted when env var is set', () => {
      const { dir: cwd, sharedDir, cleanup: cleanup1 } = createTestDir(true);
      const { cleanup: cleanup2 } = createTestDir();

      try {
        // Create different configs
        process.env.AGENTBUS_BUS_ID = sharedDir;
        resetBusConfig();

        const configFromEnv = resolveBusConfig(cwd);
        expect(configFromEnv.source).toBe('env');

        // Unset env var and resolve again
        delete process.env.AGENTBUS_BUS_ID;
        resetBusConfig();

        const configFromFile = resolveBusConfig(cwd);
        expect(configFromFile.source).toBe('config');
        expect(configFromFile.bus_dir).toBe(cwd);
      } finally {
        cleanup1();
        cleanup2();
      }
    });

    test('env var takes precedence over config in ancestor walk', () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-ancestor-'));
      fs.mkdirSync(path.join(rootDir, 'packages', 'subdir'), { recursive: true });
      const subDir = path.join(rootDir, 'packages', 'subdir');
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-env-target-'));

      try {
        // Create config at root
        fs.writeFileSync(
          path.join(rootDir, '.agentbus.json'),
          JSON.stringify({ bus: '.' })
        );

        // Set env var to different directory
        process.env.AGENTBUS_BUS_ID = envDir;
        resetBusConfig();

        // Resolve from subdir - should use env var
        const config = resolveBusConfig(subDir);
        expect(config.source).toBe('env');
        expect(config.bus_dir).toBe(envDir);
        expect(config.projectHash).toBe(hashProjectPath(envDir));
      } finally {
        try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(envDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
});
