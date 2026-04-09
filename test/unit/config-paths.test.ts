import { describe, test, expect, afterEach } from 'bun:test';
import { resolveBusConfig, resetBusConfig } from '../../src/config';
import { createTestBusEnv } from '../helpers';
import * as fs from 'fs';
import * as path from 'path';

describe('config-paths (T4)', () => {
  afterEach(() => {
    resetBusConfig();
  });

  test('T4.1: bus with absolute path', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const absPath = path.join(root, 'my-bus-dir');
      fs.mkdirSync(absPath, { recursive: true });

      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: absPath })
      );

      const config = resolveBusConfig(root);
      expect(config.bus_dir).toBe(absPath);
    } finally {
      cleanup();
    }
  });

  test('T4.2: bus with relative path "."', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: '.' })
      );

      const config = resolveBusConfig(root);
      expect(config.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });

  test('T4.3: bus with relative path ".."', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create parent directory
      const parentDir = path.dirname(root);
      // Create a subdirectory for the test
      const subDir = path.join(parentDir, 'test-subdir');
      fs.mkdirSync(subDir, { recursive: true });

      // Create .agentsynclayer.json in subDir pointing to parent with ".."
      fs.writeFileSync(
        path.join(subDir, '.agentsynclayer.json'),
        JSON.stringify({ bus: '..' })
      );

      const config = resolveBusConfig(subDir);
      expect(config.bus_dir).toBe(parentDir);
    } finally {
      cleanup();
    }
  });

  test('T4.4: db omitted, bus set → db_dir === bus_dir', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const busDir = path.join(root, 'bus');
      fs.mkdirSync(busDir, { recursive: true });

      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: busDir })
      );

      const config = resolveBusConfig(root);
      expect(config.db_dir).toBe(busDir);
    } finally {
      cleanup();
    }
  });

  test('T4.5: db set to different directory', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const busDir = path.join(root, 'bus');
      const dbDir = path.join(root, 'db');
      fs.mkdirSync(busDir, { recursive: true });
      fs.mkdirSync(dbDir, { recursive: true });

      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: busDir, db: dbDir })
      );

      const config = resolveBusConfig(root);
      expect(config.bus_dir).toBe(busDir);
      expect(config.db_dir).toBe(dbDir);
    } finally {
      cleanup();
    }
  });

  test('T4.6: db with relative path', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      const busDir = path.join(root, 'bus');
      const dbDir = path.join(root, 'db');
      fs.mkdirSync(busDir, { recursive: true });
      fs.mkdirSync(dbDir, { recursive: true });

      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: './bus', db: './db' })
      );

      const config = resolveBusConfig(root);
      expect(config.bus_dir).toBe(busDir);
      expect(config.db_dir).toBe(dbDir);
    } finally {
      cleanup();
    }
  });

  test('T4.7: symlinked CWD → realpathSync resolves', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create the real directory
      const realDir = path.join(root, 'real-project');
      fs.mkdirSync(realDir, { recursive: true });

      // Create a symlink to it
      const symlinkDir = path.join(root, 'symlink-project');
      fs.symlinkSync(realDir, symlinkDir, 'junction');

      fs.writeFileSync(
        path.join(realDir, '.agentsynclayer.json'),
        JSON.stringify({ bus: '.' })
      );

      // Resolve from symlink path
      const config = resolveBusConfig(symlinkDir);
      // Should resolve to the real path
      expect(config.bus_dir).toBe(realDir);
    } finally {
      cleanup();
    }
  });

  test('T4.8: symlinked bus path → realpathSync resolves', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create the real bus directory
      const realBusDir = path.join(root, 'real-bus');
      fs.mkdirSync(realBusDir, { recursive: true });

      // Create a symlink to the bus directory
      const busSymlink = path.join(root, 'bus-symlink');
      fs.symlinkSync(realBusDir, busSymlink, 'junction');

      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: './bus-symlink' })
      );

      const config = resolveBusConfig(root);
      // Should resolve to the real path
      expect(config.bus_dir).toBe(realBusDir);
    } finally {
      cleanup();
    }
  });
});
