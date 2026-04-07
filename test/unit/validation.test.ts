import { describe, expect, test } from 'bun:test';
import {
  validateChannel,
  validateMessage,
  validateFilePath,
  validateMessageType,
  clamp,
  isValidUUID,
  isValidAgentId,
  isValidProjectHash,
  validateTimeout,
  validateLimit,
  ValidationException,
} from '../../src/validation';

describe('validateChannel', () => {
  test('accepts valid channel names', () => {
    expect(validateChannel('general')).toBe('general');
    expect(validateChannel('my-channel')).toBe('my-channel');
    expect(validateChannel('my_channel')).toBe('my_channel');
    expect(validateChannel('channel123')).toBe('channel123');
    expect(validateChannel('CHANNEL')).toBe('channel'); // lowercase
    expect(validateChannel('  general  ')).toBe('general'); // trimmed
  });

  test('rejects invalid channel names', () => {
    expect(() => validateChannel('')).toThrow(ValidationException);
    expect(() => validateChannel('channel with spaces')).toThrow(ValidationException);
    expect(() => validateChannel('channel/name')).toThrow(ValidationException);
    expect(() => validateChannel('channel.name')).toThrow(ValidationException);
    expect(() => validateChannel('a'.repeat(65))).toThrow(ValidationException);
  });
});

describe('validateMessage', () => {
  test('accepts valid messages', () => {
    expect(validateMessage('Hello world')).toBe('Hello world');
    expect(validateMessage('  trimmed  ')).toBe('trimmed');
    expect(validateMessage('a')).toBe('a');
  });

  test('rejects empty messages', () => {
    expect(() => validateMessage('')).toThrow(ValidationException);
    expect(() => validateMessage('   ')).toThrow(ValidationException);
  });

  test('rejects messages over 4096 chars', () => {
    expect(() => validateMessage('a'.repeat(4097))).toThrow(ValidationException);
    expect(() => validateMessage('a'.repeat(5000))).toThrow(ValidationException);
  });

  test('accepts exactly 4096 characters', () => {
    expect(validateMessage('a'.repeat(4096)).length).toBe(4096);
  });
});

describe('validateFilePath', () => {
  test('accepts valid file paths', () => {
    expect(validateFilePath('src/index.ts')).toBe('src/index.ts');
    expect(validateFilePath('package.json')).toBe('package.json');
    expect(validateFilePath('src/nested/deep/file.ts')).toBe('src/nested/deep/file.ts');
    expect(validateFilePath('a/b/c')).toBe('a/b/c');
  });

  test('normalizes backslashes', () => {
    expect(validateFilePath('src\\index.ts')).toBe('src/index.ts');
  });

  test('rejects empty paths', () => {
    expect(() => validateFilePath('')).toThrow(ValidationException);
    expect(() => validateFilePath('   ')).toThrow(ValidationException);
  });

  test('rejects absolute paths', () => {
    expect(() => validateFilePath('/src/index.ts')).toThrow(ValidationException);
    expect(() => validateFilePath('/absolute/path')).toThrow(ValidationException);
  });

  test('rejects paths with .. segments', () => {
    expect(() => validateFilePath('../secret')).toThrow(ValidationException);
    expect(() => validateFilePath('src/../secret')).toThrow(ValidationException);
    expect(() => validateFilePath('a/../b')).toThrow(ValidationException);
  });

  test('rejects paths with double slashes', () => {
    expect(() => validateFilePath('src//index.ts')).toThrow(ValidationException);
    expect(() => validateFilePath('a//b')).toThrow(ValidationException);
  });
});

describe('validateMessageType', () => {
  test('accepts valid message types', () => {
    expect(validateMessageType('info')).toBe('info');
    expect(validateMessageType('status')).toBe('status');
    expect(validateMessageType('error')).toBe('error');
    expect(validateMessageType('coordination')).toBe('coordination');
    expect(validateMessageType('claim')).toBe('claim');
    expect(validateMessageType('release')).toBe('release');
  });

  test('rejects invalid message types', () => {
    expect(() => validateMessageType('unknown')).toThrow(ValidationException);
    expect(() => validateMessageType('')).toThrow(ValidationException);
    expect(() => validateMessageType('INFO')).toThrow(ValidationException);
  });
});

describe('clamp', () => {
  test('clamps values within range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 1, 10)).toBe(1);
    expect(clamp(15, 1, 10)).toBe(10);
  });

  test('handles negative ranges', () => {
    expect(clamp(-5, -10, 10)).toBe(-5);
  });

  test('handles equal min and max', () => {
    expect(clamp(5, 5, 5)).toBe(5);
  });
});

describe('isValidUUID', () => {
  test('accepts valid UUIDs', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUUID('6ba7b810-9dad-41d1-80b4-00c04fd430c8')).toBe(true);
  });

  test('rejects invalid UUIDs', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false);
    expect(isValidUUID('')).toBe(false);
    expect(isValidUUID('550e8400-e29b-51d4-a716-446655440000')).toBe(false); // wrong version
  });
});

describe('isValidAgentId', () => {
  test('accepts valid agent IDs', () => {
    expect(isValidAgentId('devbox-48201-a7f2')).toBe(true);
    expect(isValidAgentId('my-laptop-12345-7b3c')).toBe(true);
    expect(isValidAgentId('host.name-99999-abcd')).toBe(true);
    expect(isValidAgentId('a-1-abcd')).toBe(true);
  });

  test('rejects invalid agent IDs', () => {
    expect(isValidAgentId('devbox-a7f2')).toBe(false); // missing pid
    expect(isValidAgentId('devbox-48201')).toBe(false); // missing random
    expect(isValidAgentId('devbox-48201-xyz')).toBe(false); // wrong random format
    expect(isValidAgentId('')).toBe(false);
  });
});

describe('isValidProjectHash', () => {
  test('accepts valid project hashes', () => {
    expect(isValidProjectHash('a1b2c3d4e5f6')).toBe(true);
    expect(isValidProjectHash('000000000000')).toBe(true);
    expect(isValidProjectHash('ABCDEF123456')).toBe(false); // uppercase
  });

  test('rejects invalid project hashes', () => {
    expect(isValidProjectHash('abc')).toBe(false); // too short
    expect(isValidProjectHash('a1b2c3d4e5f6g7')).toBe(false); // too long
    expect(isValidProjectHash('GHIJKL123456')).toBe(false); // uppercase
    expect(isValidProjectHash('')).toBe(false);
  });
});

describe('validateTimeout', () => {
  test('accepts valid timeouts', () => {
    expect(validateTimeout(1)).toBe(1);
    expect(validateTimeout(15)).toBe(15);
    expect(validateTimeout(30)).toBe(30);
  });

  test('rejects invalid timeouts', () => {
    expect(() => validateTimeout(0)).toThrow(ValidationException);
    expect(() => validateTimeout(31)).toThrow(ValidationException);
    expect(() => validateTimeout(-1)).toThrow(ValidationException);
    expect(() => validateTimeout(1.5)).toThrow(ValidationException);
  });
});

describe('validateLimit', () => {
  test('accepts valid limits', () => {
    expect(validateLimit(1)).toBe(1);
    expect(validateLimit(50)).toBe(50);
    expect(validateLimit(100)).toBe(100);
  });

  test('rejects invalid limits', () => {
    expect(() => validateLimit(0)).toThrow(ValidationException);
    expect(() => validateLimit(101)).toThrow(ValidationException);
    expect(() => validateLimit(-1)).toThrow(ValidationException);
    expect(() => validateLimit(1.5)).toThrow(ValidationException);
  });
});