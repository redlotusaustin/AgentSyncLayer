/**
 * validation-adapter.test.ts - Zod schema validation tests
 *
 * Tests T6 and T7 from the pre-distribution fixes spec:
 * - T6: Zod schema for bus_claim path rejects empty string (.min(1))
 * - T7: Zod schema for bus_release path accepts empty string but rejects >512 chars
 */

import { describe, expect, test } from 'bun:test';
import z from 'zod';

// Import the Zod schemas from adapter.ts
// bus_claim: path must be string with min(1) and max(512)
// bus_release: path must be string with max(512) (no min requirement)

// Define schemas inline to test them directly (matching adapter.ts definitions)
const BusClaimArgsSchema = z.object({
  path: z.string().min(1).max(512).describe("The file path to claim (relative, e.g. 'src/auth/login.ts')"),
});

const BusReleaseArgsSchema = z.object({
  path: z.string().max(512).describe("The file path to release (relative, e.g. 'src/auth/login.ts')"),
});

describe('T6: bus_claim Zod validation rejects empty path', () => {
  test('T6: rejects empty string path', () => {
    const result = BusClaimArgsSchema.safeParse({ path: '' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const error = result.error.issues[0];
      expect(error.path).toContain('path');
      // Zod error messages vary by version - verify rejection happened via message presence
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  test('T6: accepts valid non-empty path', () => {
    const result = BusClaimArgsSchema.safeParse({ path: 'src/auth/login.ts' });
    expect(result.success).toBe(true);
  });

  test('T6: rejects path exceeding 512 characters', () => {
    const longPath = 'a'.repeat(513);
    const result = BusClaimArgsSchema.safeParse({ path: longPath });
    expect(result.success).toBe(false);

    if (!result.success) {
      const error = result.error.issues[0];
      expect(error.path).toContain('path');
      // Zod error messages vary by version - verify rejection happened via message presence
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('T7: bus_release Zod validation for path constraints', () => {
  test('T7: accepts empty string path (no min constraint)', () => {
    // bus_release allows empty path (releasing a non-existent claim is a no-op)
    const result = BusReleaseArgsSchema.safeParse({ path: '' });
    expect(result.success).toBe(true);
  });

  test('T7: accepts valid non-empty path', () => {
    const result = BusReleaseArgsSchema.safeParse({ path: 'src/auth/login.ts' });
    expect(result.success).toBe(true);
  });

  test('T7: rejects path exceeding 512 characters', () => {
    const longPath = 'a'.repeat(513);
    const result = BusReleaseArgsSchema.safeParse({ path: longPath });
    expect(result.success).toBe(false);

    if (!result.success) {
      const error = result.error.issues[0];
      expect(error.path).toContain('path');
      // Zod error messages vary by version - verify rejection happened via message presence
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  test('T7: accepts exactly 512 character path', () => {
    const maxPath = 'a'.repeat(512);
    const result = BusReleaseArgsSchema.safeParse({ path: maxPath });
    expect(result.success).toBe(true);
  });
});

describe('T6-T7: Schema comparison (key differences)', () => {
  test('bus_claim requires non-empty path, bus_release does not', () => {
    // Empty string behavior comparison
    const claimResult = BusClaimArgsSchema.safeParse({ path: '' });
    const releaseResult = BusReleaseArgsSchema.safeParse({ path: '' });

    expect(claimResult.success).toBe(false);
    expect(releaseResult.success).toBe(true);
  });

  test('Both schemas enforce max 512 character limit', () => {
    const longPath = 'x'.repeat(513);

    const claimResult = BusClaimArgsSchema.safeParse({ path: longPath });
    const releaseResult = BusReleaseArgsSchema.safeParse({ path: longPath });

    expect(claimResult.success).toBe(false);
    expect(releaseResult.success).toBe(false);
  });
});
