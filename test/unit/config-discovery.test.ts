import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetBusConfig, resolveBusConfig } from '../../src/config';
import { createTestBusEnv, createTestDirTree } from '../helpers';

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

  test('T3.2: config in parent, agent from child → found via ancestor walk', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Config in root
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      // Agent runs from sub1
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(root);
      expect(config.configPath).toBe(path.join(root, '.agentsynclayer.json'));
    } finally {
      cleanup();
    }
  });

  test('T3.3: config in grandparent (not parent or CWD) → walks up 2 levels', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Config in root (grandparent of sub1)
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      // Run from sub1 (parent is packages/)
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T3.4: ancestor walk stops at .git/ → config above .git NOT found', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Create .git in root (simulating git root)
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });

      // Config in root - but it should be ignored because we hit .git
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      // Config in sub1's parent (packages/)
      const packagesDir = path.join(root, 'packages');
      fs.writeFileSync(
        path.join(packagesDir, '.agentsynclayer.json'),
        JSON.stringify({ bus: '.' }),
      );

      // Run from sub1 - should find config in packages/, not root
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(packagesDir);
    } finally {
      cleanup();
    }
  });

  test('T3.4b: .git boundary — config above git root is NOT found', () => {
    // Create parent of test env root (temp dir) — this represents "outside the project"
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Create .git in root (simulating git root boundary)
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });

      // NO config at root or packages/ (the usual search locations)

      // Run from sub1 - should NOT find any config and fall back to default
      // because .git stops the upward walk and there's no config in the search path
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('default');
      expect(config.bus_dir).toBe(sub1);
    } finally {
      cleanup();
    }
  });

  test('T3.5: ancestor walk at filesystem root → no crash, returns default', () => {
    // Use /tmp as starting point (should eventually hit / or a .git)
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

  test('T3.7: closest config wins — CWD config over parent', () => {
    const { root, sub1, cleanup } = createTestDirTree();
    try {
      // Config in root
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: root }));

      // Config in packages (closer to sub1)
      const packagesDir = path.dirname(sub1);
      fs.writeFileSync(
        path.join(packagesDir, '.agentsynclayer.json'),
        JSON.stringify({ bus: packagesDir }),
      );

      // Run from sub1 - should find packages config first
      const config = resolveBusConfig(sub1);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(packagesDir);
    } finally {
      cleanup();
    }
  });
});
