import { describe, expect, test, beforeAll } from 'bun:test';
import {
  hashProjectPath,
  buildKey,
  KeyBuilder,
  createKeyBuilder,
  extractKeyType,
  extractKeyIdentifier,
  isProjectKey,
  extractProjectHash,
} from '../../src/namespace';
import * as fs from 'fs';
import * as path from 'path';

// Test directory for hash tests - use /tmp for Bun compatibility
const testDir = path.join('/tmp', 'agentbus-test-' + Date.now());

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
    expect(buildKey(projectHash, 'history', 'general')).toBe('opencode:a1b2c3d4e5f6:history:general');
  });

  test('builds agent key', () => {
    expect(buildKey(projectHash, 'agent', 'devbox-1234-abcd')).toBe('opencode:a1b2c3d4e5f6:agent:devbox-1234-abcd');
  });

  test('builds claim key', () => {
    expect(buildKey(projectHash, 'claim', 'src/index.ts')).toBe('opencode:a1b2c3d4e5f6:claim:src/index.ts');
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
    expect(builder.claim('src/auth/login.ts')).toBe('opencode:a1b2c3d4e5f6:claim:src/auth/login.ts');
  });

  test('builds channels key', () => {
    expect(builder.channels()).toBe('opencode:a1b2c3d4e5f6:channels');
  });

  test('builds patterns', () => {
    expect(builder.pattern('agent')).toBe('opencode:a1b2c3d4e5f6:agent:*');
    expect(builder.pattern('claim', '*.ts')).toBe('opencode:a1b2c3d4e5f6:claim:*.ts');
  });
});

describe('extractKeyType', () => {
  const projectHash = 'a1b2c3d4e5f6';

  test('extracts key types', () => {
    expect(extractKeyType('opencode:a1b2c3d4e5f6:ch:general', projectHash)).toBe('ch');
    expect(extractKeyType('opencode:a1b2c3d4e5f6:history:general', projectHash)).toBe('history');
    expect(extractKeyType('opencode:a1b2c3d4e5f6:agent:devbox-1234', projectHash)).toBe('agent');
    expect(extractKeyType('opencode:a1b2c3d4e5f6:claim:src/file.ts', projectHash)).toBe('claim');
    expect(extractKeyType('opencode:a1b2c3d4e5f6:channels', projectHash)).toBe('channels');
  });

  test('returns null for invalid keys', () => {
    expect(extractKeyType('opencode:other:ch:general', projectHash)).toBe(null);
    expect(extractKeyType('other:a1b2c3d4e5f6:ch:general', projectHash)).toBe(null);
    expect(extractKeyType('not-a-valid-key', projectHash)).toBe(null);
  });
});

describe('extractKeyIdentifier', () => {
  const projectHash = 'a1b2c3d4e5f6';

  test('extracts identifiers', () => {
    expect(extractKeyIdentifier('opencode:a1b2c3d4e5f6:ch:general', projectHash, 'ch')).toBe('general');
    expect(extractKeyIdentifier('opencode:a1b2c3d4e5f6:agent:devbox-1234', projectHash, 'agent')).toBe('devbox-1234');
    expect(extractKeyIdentifier('opencode:a1b2c3d4e5f6:claim:src/file.ts', projectHash, 'claim')).toBe('src/file.ts');
  });

  test('returns null for wrong type', () => {
    expect(extractKeyIdentifier('opencode:a1b2c3d4e5f6:ch:general', projectHash, 'agent')).toBe(null);
  });
});

describe('isProjectKey', () => {
  const projectHash = 'a1b2c3d4e5f6';

  test('identifies project keys', () => {
    expect(isProjectKey('opencode:a1b2c3d4e5f6:ch:general', projectHash)).toBe(true);
    expect(isProjectKey('opencode:a1b2c3d4e5f6:channels', projectHash)).toBe(true);
  });

  test('rejects keys from other projects', () => {
    expect(isProjectKey('opencode:otherhash123:ch:general', projectHash)).toBe(false);
    expect(isProjectKey('other:opencode:a1b2c3d4e5f6:ch:general', projectHash)).toBe(false);
  });
});

describe('extractProjectHash', () => {
  test('extracts project hash from keys', () => {
    expect(extractProjectHash('opencode:a1b2c3d4e5f6:ch:general')).toBe('a1b2c3d4e5f6');
    expect(extractProjectHash('opencode:000000000000:channels')).toBe('000000000000');
  });

  test('returns null for invalid keys', () => {
    expect(extractProjectHash('invalid')).toBe(null);
    expect(extractProjectHash('opencode:short:ch:general')).toBe(null);
    expect(extractProjectHash('opencode:TOOLONGHASH123:ch:general')).toBe(null);
  });
});