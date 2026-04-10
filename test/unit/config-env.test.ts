import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetBusConfig, resolveBusConfig } from '../../src/config';
import { createTestBusEnv } from '../helpers';

describe('config-env (T2)', () => {
  const originalEnvBusId = process.env.AGENTSYNCLAYER_BUS_ID;

  beforeAll(() => {
    // Ensure clean state
    resetBusConfig();
  });

  afterAll(() => {
    // Restore original env var
    if (originalEnvBusId !== undefined) {
      process.env.AGENTSYNCLAYER_BUS_ID = originalEnvBusId;
    } else {
      delete process.env.AGENTSYNCLAYER_BUS_ID;
    }
    resetBusConfig();
  });

  afterEach(() => {
    resetBusConfig();
    // Clean up env var between tests
    delete process.env.AGENTSYNCLAYER_BUS_ID;
  });

  test('T2.1: AGENTSYNCLAYER_BUS_ID=/tmp/test-bus → source: env', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create the directory that will be referenced by the env var
      fs.mkdirSync(root, { recursive: true });
      process.env.AGENTSYNCLAYER_BUS_ID = root;

      const config = resolveBusConfig(root);
      expect(config.source).toBe('env');
      expect(config.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T2.2: path in env var is resolved (absolute)', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const subdir = path.join(root, 'subdir');
      fs.mkdirSync(subdir, { recursive: true });
      // Use absolute path (env var expects absolute or resolvable paths)
      process.env.AGENTSYNCLAYER_BUS_ID = subdir;

      const config = resolveBusConfig(root);
      expect(config.source).toBe('env');
      expect(config.bus_dir).toBe(subdir);
    } finally {
      cleanup();
    }
  });

  test('T2.3: env var overrides .agentsynclayer.json in CWD', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create .agentsynclayer.json in root pointing to subdir1
      const subdir1 = path.join(root, 'subdir1');
      const subdir2 = path.join(root, 'subdir2');
      fs.mkdirSync(subdir1, { recursive: true });
      fs.mkdirSync(subdir2, { recursive: true });

      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: subdir1 }));

      // But env var points to subdir2
      process.env.AGENTSYNCLAYER_BUS_ID = subdir2;

      const config = resolveBusConfig(root);
      expect(config.source).toBe('env');
      expect(config.bus_dir).toBe(subdir2);
    } finally {
      cleanup();
    }
  });

  test('T2.4: non-existent path → source: default', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      process.env.AGENTSYNCLAYER_BUS_ID = '/non/existent/path/that/does/not/exist';

      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
    } finally {
      cleanup();
    }
  });

  test('T2.5: resetBusConfig then env var re-evaluated', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const dir = path.join(root, 'mybus');
      fs.mkdirSync(dir, { recursive: true });
      process.env.AGENTSYNCLAYER_BUS_ID = dir;

      // First resolution
      const config1 = resolveBusConfig(root);
      expect(config1.source).toBe('env');

      // Reset and change env var
      resetBusConfig();
      const newDir = path.join(root, 'mybus2');
      fs.mkdirSync(newDir, { recursive: true });
      process.env.AGENTSYNCLAYER_BUS_ID = newDir;

      // New resolution should pick up the new env var
      const config2 = resolveBusConfig(root);
      expect(config2.source).toBe('env');
      expect(config2.bus_dir).toBe(newDir);
    } finally {
      cleanup();
    }
  });
});
