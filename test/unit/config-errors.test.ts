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
        path.join(root, '.agentsynclayer.json'),
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
        path.join(root, '.agentsynclayer.json'),
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
        path.join(root, '.agentsynclayer.json'),
        JSON.stringify({ bus: '/non/existent/path' })
      );

      const config = resolveBusConfig(root);
      expect(config.source).toBe('default');
    } finally {
      cleanup();
    }
  });

  test('T5.4: bus pointing to a regular file → source: default', () => {
    const { root, cleanup } = createTestBusEnv();
    try {
      // Create a regular file where a directory is expected
      const fakeBusDir = path.join(root, 'not-a-directory.txt');
      fs.writeFileSync(fakeBusDir, 'not a directory');

      // Create .agentsynclayer.json pointing to that file
      fs.writeFileSync(
        path.join(root, '.agentsynclayer.json'),
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
        path.join(root, '.agentsynclayer.json'),
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
