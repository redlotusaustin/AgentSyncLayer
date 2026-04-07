import { describe, expect, test } from 'bun:test';
import {
  generateAgentId,
  composeAgentId,
  parseAgentId,
  isValidAgentId,
  extractHostname,
  extractPid,
  extractRandomSuffix,
  isSameHostname,
  shortenAgentId,
} from '../../src/agent';

describe('generateAgentId', () => {
  test('generates valid agent ID', () => {
    const id = generateAgentId();
    expect(isValidAgentId(id)).toBe(true);
  });

  test('generates unique IDs on multiple calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateAgentId());
    }
    // With random suffix, we expect mostly unique IDs
    // (there is a very small chance of collision, but 1/65536 per call)
    expect(ids.size).toBe(100);
  });

  test('ID contains hyphen-separated parts', () => {
    const id = generateAgentId();
    const parts = id.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  test('last part is 4 hex characters', () => {
    const id = generateAgentId();
    const parts = id.split('-');
    const lastPart = parts[parts.length - 1];
    expect(/^[a-f0-9]{4}$/.test(lastPart)).toBe(true);
  });
});

describe('composeAgentId', () => {
  test('creates valid agent ID from components', () => {
    const id = composeAgentId('devbox', 12345, 'a7f2');
    expect(id).toBe('devbox-12345-a7f2');
    expect(isValidAgentId(id)).toBe(true);
  });

  test('sanitizes hostname', () => {
    const id = composeAgentId('my host name', 123, 'abcd');
    expect(id).toBe('my-host-name-123-abcd');
  });

  test('handles special characters', () => {
    const id = composeAgentId('host@#$%name', 123, 'abcd');
    expect(id).toBe('host----name-123-abcd');
  });

  test('converts random hex to lowercase', () => {
    const id = composeAgentId('host', 123, 'ABCD');
    expect(id).toBe('host-123-abcd');
  });
});

describe('parseAgentId', () => {
  test('parses valid agent ID', () => {
    const parsed = parseAgentId('devbox-48201-a7f2');
    expect(parsed).not.toBeNull();
    expect(parsed!.hostname).toBe('devbox');
    expect(parsed!.pid).toBe(48201);
    expect(parsed!.randomHex).toBe('a7f2');
  });

  test('handles complex hostnames', () => {
    const parsed = parseAgentId('my.laptop.local-12345-7b3c');
    expect(parsed).not.toBeNull();
    expect(parsed!.hostname).toBe('my.laptop.local');
    expect(parsed!.pid).toBe(12345);
    expect(parsed!.randomHex).toBe('7b3c');
  });

  test('returns null for invalid format', () => {
    expect(parseAgentId('invalid')).toBeNull();
    expect(parseAgentId('devbox-a7f2')).toBeNull(); // missing pid
    expect(parseAgentId('devbox-12345')).toBeNull(); // missing random
    expect(parseAgentId('devbox-12345-xyz')).toBeNull(); // random not hex
  });
});

describe('isValidAgentId', () => {
  test('accepts valid agent IDs', () => {
    expect(isValidAgentId('devbox-48201-a7f2')).toBe(true);
    expect(isValidAgentId('host-1-abcd')).toBe(true);
    expect(isValidAgentId('a.b.c-99999-0001')).toBe(true);
    expect(isValidAgentId('my_host-1234-ffff')).toBe(true);
  });

  test('rejects invalid agent IDs', () => {
    expect(isValidAgentId('devbox')).toBe(false);
    expect(isValidAgentId('devbox-1234')).toBe(false);
    expect(isValidAgentId('devbox-1234-abc')).toBe(false); // random too short
    expect(isValidAgentId('devbox-1234-abcde')).toBe(false); // random too long
    expect(isValidAgentId('')).toBe(false);
  });
});

describe('extractHostname', () => {
  test('extracts hostname from valid ID', () => {
    expect(extractHostname('devbox-48201-a7f2')).toBe('devbox');
    expect(extractHostname('my.host-12345-abcd')).toBe('my.host');
  });

  test('returns null for invalid ID', () => {
    expect(extractHostname('invalid')).toBeNull();
  });
});

describe('extractPid', () => {
  test('extracts PID from valid ID', () => {
    expect(extractPid('devbox-48201-a7f2')).toBe(48201);
    expect(extractPid('host-1-abcd')).toBe(1);
  });

  test('returns null for invalid ID', () => {
    expect(extractPid('invalid')).toBeNull();
  });
});

describe('extractRandomSuffix', () => {
  test('extracts random suffix from valid ID', () => {
    expect(extractRandomSuffix('devbox-48201-a7f2')).toBe('a7f2');
    expect(extractRandomSuffix('host-1-abcd')).toBe('abcd');
  });

  test('returns null for invalid ID', () => {
    expect(extractRandomSuffix('invalid')).toBeNull();
  });
});

describe('isSameHostname', () => {
  test('detects same hostname', () => {
    expect(isSameHostname('devbox-48201-a7f2', 'devbox-49102-b3c4')).toBe(true);
  });

  test('detects different hostnames', () => {
    expect(isSameHostname('devbox-48201-a7f2', 'laptop-49102-b3c4')).toBe(false);
  });

  test('handles invalid IDs', () => {
    expect(isSameHostname('invalid', 'devbox-48201-a7f2')).toBe(false);
    expect(isSameHostname('devbox-48201-a7f2', 'invalid')).toBe(false);
  });
});

describe('shortenAgentId', () => {
  test('returns full ID if under max length', () => {
    const id = 'devbox-48201-a7f2';
    expect(shortenAgentId(id, 20)).toBe(id);
  });

  test('shortens long hostnames', () => {
    const id = 'this-is-a-very-long-hostname-48201-a7f2';
    const shortened = shortenAgentId(id, 20);
    expect(shortened.length).toBeLessThanOrEqual(20);
    expect(shortened).toContain('...');
    expect(shortened).toMatch(/-48201-a7f2$/); // ends with pid and random
  });

  test('handles maxLength smaller than suffix', () => {
    const id = 'devbox-48201-a7f2';
    const shortened = shortenAgentId(id, 10);
    expect(shortened.length).toBeLessThanOrEqual(10);
  });
});