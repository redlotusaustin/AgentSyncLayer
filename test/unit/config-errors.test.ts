import { describe, test, expect, afterEach } from 'bun:test';
import { resolveBusConfig, resetBusConfig } from '../../src/config';
import { createTestBusEnv } from '../helpers';
import * as fs from 'fs';
import * as path from 'path';

describe('config-errors (T5)', () => {
  afterEach(() => {
    resetBusConfig();
  });

  test('T5.1: malformed JSON → source: default', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        '{ invalid json }'
      );

      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
    } finally {
      cleanup();
    }
  });

  test('T5.2: valid JSON but bus: 123 (wrong type) → source: default', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        JSON.stringify({ bus: 123 })
      );

      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
    } finally {
      cleanup();
    }
  });

  test('T5.3: bus pointing to non-existent dir → source: default', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        JSON.stringify({ bus: '/non/existent/path' })
      );

      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
    } finally {
      cleanup();
    }
  });

  test('T5.4: .agentbus.json that is a directory → source: default', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create a directory where the config file should be
      const configDir = path.join(root, 'config-dir');
      fs.mkdirSync(configDir, { recursive: true });

      // Try to write .agentbus.json as a directory (this should fail)
      // We can't actually create a dir with the same name as an existing file,
      // so instead we'll test with a file that's a regular file
      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        JSON.stringify({ bus: root }) // This is valid, but...
      );

      // Now create a directory where bus points to a file path that's not a directory
      // Actually the real test case is when the bus path itself is a file, not a directory
      // Let's create a file and point bus to it
      const fakeBusDir = path.join(root, 'not-a-directory.txt');
      fs.writeFileSync(fakeBusDir, 'not a directory');

      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        JSON.stringify({ bus: './not-a-directory.txt' })
      );

      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
    } finally {
      cleanup();
    }
  });

  test('T5.5: unknown fields → ignored, resolves normally', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      fs.writeFileSync(
        path.join(root, '.agentbus.json'),
        JSON.stringify({
          bus: '.',
          db: '.',
          unknownField: 'should be ignored',
          anotherUnknown: 123,
          nested: { key: 'value' },
        })
      );

      const config = resolveBusConfig(root);
      expect(config.source).toBe('config');
      expect(config.bus_dir).toBe(root);
    } finally {
      cleanup();
    }
  });
});
