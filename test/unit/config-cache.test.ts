import { describe, test, expect, afterEach } from 'bun:test';
import { resolveBusConfig, resetBusConfig } from '../../src/config';
import { createTestBusEnv } from '../helpers';
import * as fs from 'fs';
import * as path from 'path';

describe('config-cache (T6)', () => {
  afterEach(() => {
    resetBusConfig();
  });

  test('T6.1: same cwd returns same BusConfig object (reference equality)', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const config1 = resolveBusConfig(root);
      const config2 = resolveBusConfig(root);
      expect(config1).toBe(config2);
    } finally {
      cleanup();
    }
  });

  test('T6.2: resetBusConfig() clears cache', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // First resolution - caches result
      const config1 = resolveBusConfig(root);
      expect(config1.source).toBe('default');

      // Reset cache
      resetBusConfig();

      // New resolution should return a new object
      const config2 = resolveBusConfig(root);
      expect(config1).not.toBe(config2);
    } finally {
      cleanup();
    }
  });

  test('T6.3: reset then modify .agentbus.json → new call picks up changes', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Initially no config file
      const config1 = resolveBusConfig(root);
      expect(config1.source).toBe('default');

      // Create config file
      const busDir = path.join(root, 'new-bus');
      fs.mkdirSync(busDir, { recursive: true });
      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        JSON.stringify({ bus: './new-bus' })
      );

      // Reset cache to force re-resolution
      resetBusConfig();

      // New resolution should pick up the config file
      const config2 = resolveBusConfig(root);
      expect(config2.source).toBe('config');
      expect(config2.bus_dir).toBe(busDir);
    } finally {
      cleanup();
    }
  });
});
