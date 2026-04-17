import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resetBusConfig, resolveBusConfig } from '../../src/config';
import { createTestBusEnv } from '../helpers';

/**
 * Create a test directory tree for config tests.
 * Creates: root/packages/api, root/packages/web
 */
function createTestDirTree(): {
  root: string;
  sub1: string;
  sub2: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-tree-test-'));
  const sub1 = path.join(root, 'packages', 'api');
  const sub2 = path.join(root, 'packages', 'web');
  fs.mkdirSync(sub1, { recursive: true });
  fs.mkdirSync(sub2, { recursive: true });
  return {
    root,
    sub1,
    sub2,
    cleanup: () => {
      resetBusConfig();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('config-discovery (T3)', () => {
  afterEach(() => {
    resetBusConfig();
  });

  test('T3.1: .agentsynclayer.json in CWD with { "bus": "." } → source: config', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const config = resolveBusConfig(root);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T3.5: /tmp no config file → returns default without crash', () => {
    // Use /tmp as starting point - should not crash even if no config
    const config = resolveBusConfig('/tmp');
    // Should not crash and should return some result
    expect(config).toBeDefined();
    expect(['default', 'config']).toContain(config.source);
  });

  test('T3.6: .agentsynclayer.json with {} (empty) → bus_dir defaults to config file dir', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({}));

      const config = resolveBusConfig(root);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T3.8: config in parent NOT visible from subdirectory', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Config in root
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      // Agent runs from sub1 - should NOT find ancestor config
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('default');
      expect(config.bus_dir).toBe(sub1);
    } finally {
      cleanup();
    }
  });

  test('T3.9: config in root NOT visible from packages subdirectory', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Config in root
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      // Run from sub1 - ancestor config should NOT be found
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('default');
      expect(config.bus_dir).toBe(sub1);
    } finally {
      cleanup();
    }
  });

  test('T3.10: config in sibling directory NOT visible', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      const sibling = path.join(root, 'sibling');
      fs.mkdirSync(sibling, { recursive: true });

      // Config in sibling
      fs.writeFileSync(path.join(sibling, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      // Run from sub1 - sibling config should NOT be found
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('default');
      expect(config.bus_dir).toBe(sub1);
    } finally {
      cleanup();
    }
  });

  test('T3.11: each subdirectory has independent default config', () => {
    const { root, sub1, sub2, cleanup } = createTestDirTree();
    try {
      // No config files anywhere

      // Run from sub1
      const config1 = resolveBusConfig(sub1);
      expect(config1.source).toBe('default');
      expect(config1.bus_dir).toBe(sub1);

      // Reset cache to simulate fresh resolution
      resetBusConfig();

      // Run from sub2
      const config2 = resolveBusConfig(sub2);
      expect(config2.source).toBe('default');
      expect(config2.bus_dir).toBe(sub2);

      // They should have different project hashes
      expect(config1.projectHash).not.toBe(config2.projectHash);
    } finally {
      cleanup();
    }
  });

  test('T3.12: monorepo each package needs its own config', () => {
    const { root, sub1, sub2, cleanup } = createTestDirTree();
    try {
      // Config files in each package (for local config mode)
      fs.writeFileSync(
        path.join(sub1, '.agentsynclayer.json'),
        JSON.stringify({ bus: root }),
      );
      fs.writeFileSync(
        path.join(sub2, '.agentsynclayer.json'),
        JSON.stringify({ bus: root }),
      );

      // Both should resolve to root for shared bus
      const apiConfig = resolveBusConfig(sub1);
      expect(apiConfig.source).toBe('config');
      expect(apiConfig.bus_dir).toBe(root);

      resetBusConfig();

      const webConfig = resolveBusConfig(sub2);
      expect(webConfig.source).toBe('config');
      expect(webConfig.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T3.13: each monorepo package gets independent default when no config', () => {
    const { root, sub1, sub2, cleanup } = createTestDirTree();
    try {
      // No config files anywhere

      // Each package has its own default namespace
      const apiConfig = resolveBusConfig(sub1);
      const webConfig = resolveBusConfig(sub2);

      expect(apiConfig.source).toBe('default');
      expect(apiConfig.bus_dir).toBe(sub1);

      resetBusConfig();

      expect(webConfig.source).toBe('default');
      expect(webConfig.bus_dir).toBe(sub2);

      // They have different namespaces (no shared bus)
      expect(apiConfig.projectHash).not.toBe(webConfig.projectHash);
    } finally {
      cleanup();
    }
  });
});
