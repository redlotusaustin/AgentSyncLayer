import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildKey, createKeyBuilder, hashProjectPath, KeyBuilder } from '../../src/namespace';

// Test directory for hash tests - use /tmp for Bun compatibility
const testDir = path.join('/tmp', `agentsynclayer-test-${Date.now()}`);

beforeAll(() => {
  fs.mkdirSync(testDir, { recursive: true });
});

describe('hashProjectPath', () => {
  test('generates 12-character lowercase hex hash', () => {
    const hash = hashProjectPath(testDir);
    expect(hash.length).toBe(12);
    expect(/^[a-f0-9]{12}$/.test(hash)).toBe(true);
  });

  test('generates consistent hash for same path', () => {
    const hash1 = hashProjectPath(testDir);
    const hash2 = hashProjectPath(testDir);
    expect(hash1).toBe(hash2);
  });

  test('generates different hashes for different paths', () => {
    const subDir1 = path.join(testDir, 'a');
    const subDir2 = path.join(testDir, 'b');
    fs.mkdirSync(subDir1);
    fs.mkdirSync(subDir2);

    const hash1 = hashProjectPath(subDir1);
    const hash2 = hashProjectPath(subDir2);
    expect(hash1).not.toBe(hash2);
  });
});

describe('buildKey', () => {
  const projectHash = 'a1b2c3d4e5f6';

  test('builds channel key', () => {
    expect(buildKey(projectHash, 'ch', 'general')).toBe('opencode:a1b2c3d4e5f6:ch:general');
  });

  test('builds history key', () => {
    expect(buildKey(projectHash, 'history', 'general')).toBe(
      'opencode:a1b2c3d4e5f6:history:general',
    );
  });

  test('builds agent key', () => {
    expect(buildKey(projectHash, 'agent', 'devbox-1234-abcd')).toBe(
      'opencode:a1b2c3d4e5f6:agent:devbox-1234-abcd',
    );
  });

  test('builds claim key', () => {
    expect(buildKey(projectHash, 'claim', 'src/index.ts')).toBe(
      'opencode:a1b2c3d4e5f6:claim:src/index.ts',
    );
  });

  test('builds channels set key', () => {
    expect(buildKey(projectHash, 'channels')).toBe('opencode:a1b2c3d4e5f6:channels');
  });
});

describe('KeyBuilder', () => {
  const projectHash = 'a1b2c3d4e5f6';
  let builder: KeyBuilder;

  beforeAll(() => {
    builder = createKeyBuilder(projectHash);
  });

  test('creates builder instance', () => {
    expect(builder).toBeInstanceOf(KeyBuilder);
  });

  test('throws on invalid project hash', () => {
    expect(() => new KeyBuilder('invalid')).toThrow();
    expect(() => new KeyBuilder('TOOLONGHASH123')).toThrow();
    expect(() => new KeyBuilder('a1b2c3d4e5')).toThrow(); // too short
  });

  test('builds channel key', () => {
    expect(builder.channel('general')).toBe('opencode:a1b2c3d4e5f6:ch:general');
  });

  test('builds history key', () => {
    expect(builder.history('errors')).toBe('opencode:a1b2c3d4e5f6:history:errors');
  });

  test('builds agent key', () => {
    expect(builder.agent('devbox-1234-abcd')).toBe('opencode:a1b2c3d4e5f6:agent:devbox-1234-abcd');
  });

  test('builds claim key', () => {
    expect(builder.claim('src/auth/login.ts')).toBe(
      'opencode:a1b2c3d4e5f6:claim:src/auth/login.ts',
    );
  });

  test('builds channels key', () => {
    expect(builder.channels()).toBe('opencode:a1b2c3d4e5f6:channels');
  });

  test('builds patterns', () => {
    expect(builder.pattern('agent')).toBe('opencode:a1b2c3d4e5f6:agent:*');
    expect(builder.pattern('claim', '*.ts')).toBe('opencode:a1b2c3d4e5f6:claim:*.ts');
  });
});
