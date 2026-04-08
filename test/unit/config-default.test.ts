import { describe, test, expect, afterEach } from 'bun:test';
import { resolveBusConfig, resolveProjectHash, resolveDbDir, resetBusConfig } from '../../src/config';
import { createTestBusEnv } from '../helpers';
import { hashProjectPath } from '../../src/namespace';

describe('config-default (T1)', () => {
  afterEach(() => {
    resetBusConfig();
  });

  test('T1.1: resolveBusConfig with no config returns default source', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
      expect(config.bus_dir).toBe(root);
      expect(config.db_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T1.2: resolveProjectHash with no config returns hash of cwd', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const hash = resolveProjectHash(root);
      const expected = hashProjectPath(root);
      expect(hash).toBe(expected);
    } finally {
      cleanup();
    }
  });

  test('T1.3: resolveDbDir with no config returns cwd', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const dbDir = resolveDbDir(root);
      expect(dbDir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T1.4: result is cached (reference equality)', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const config1 = resolveBusConfig(root);
      const config2 = resolveBusConfig(root);
      expect(config1).toBe(config2);
    } finally {
      cleanup();
    }
  });
});
