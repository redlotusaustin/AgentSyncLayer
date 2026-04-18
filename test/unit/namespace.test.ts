import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashProjectPath } from '../../src/namespace';

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
