import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetBusConfig } from '../../src/config';
import { hashProjectPath } from '../../src/namespace';
import { busInfoExecute } from '../../src/tools/bus_info';
import { createTestToolContext } from '../fixtures';
import { createTestBusEnv } from '../helpers';

describe('bus-info (T7)', () => {
  afterEach(() => {
    resetBusConfig();
  });

  test('T7.1: bus_info with no config → source: default, configPath: null', async () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const context = createTestToolContext(root);
      const result = await busInfoExecute({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.source).toBe('default');
        expect(result.data.configPath).toBeNull();
      }
    } finally {
      cleanup();
    }
  });

  test('T7.2: bus_info with .agentsynclayer.json → source: config, configPath set', async () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const context = createTestToolContext(root);
      const result = await busInfoExecute({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.source).toBe('config');
        expect(result.data.configPath).toBe(path.join(root, '.agentsynclayer.json'));
      }
    } finally {
      cleanup();
    }
  });

  test('T7.3: bus_info with env var → source: env, configPath: null', async () => {
    const originalEnvBusId = process.env.AGENTSYNCLAYER_BUS_ID;
    try {
      const { root, cleanup } = createTestBusEnv();
      try {
        const dir = path.join(root, 'env-bus');
        fs.mkdirSync(dir, { recursive: true });
        process.env.AGENTSYNCLAYER_BUS_ID = dir;

        const context = createTestToolContext(root);
        const result = await busInfoExecute({}, context);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.source).toBe('env');
          expect(result.data.configPath).toBeNull();
        }
      } finally {
        cleanup();
        delete process.env.AGENTSYNCLAYER_BUS_ID;
      }
    } finally {
      if (originalEnvBusId !== undefined) {
        process.env.AGENTSYNCLAYER_BUS_ID = originalEnvBusId;
      }
    }
  });

  test('T7.4: projectHash matches hashProjectPath(bus_dir)', async () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const context = createTestToolContext(root);
      const result = await busInfoExecute({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const expectedHash = hashProjectPath(root);
        expect(result.data.projectHash).toBe(expectedHash);
      }
    } finally {
      cleanup();
    }
  });

  test('T7.5: response includes all 5 fields', async () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const context = createTestToolContext(root);
      const result = await busInfoExecute({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data).toHaveProperty('projectHash');
        expect(data).toHaveProperty('bus_dir');
        expect(data).toHaveProperty('db_dir');
        expect(data).toHaveProperty('source');
        expect(data).toHaveProperty('configPath');

        // Check types
        expect(typeof data.projectHash).toBe('string');
        expect(typeof data.bus_dir).toBe('string');
        expect(typeof data.db_dir).toBe('string');
        expect(['default', 'config', 'env']).toContain(data.source);
        expect(data.configPath === null || typeof data.configPath === 'string').toBe(true);
      }
    } finally {
      cleanup();
    }
  });
});
