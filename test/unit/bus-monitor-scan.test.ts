/**
 * bus-monitor-scan.test.ts - Static analysis test for T9
 *
 * Test T9: bus-monitor uses SCAN instead of KEYS
 *
 * Verifies that bus-monitor.ts does not contain redis.keys() calls.
 * Uses SCAN for production safety (non-blocking).
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Path to bus-monitor.ts source file
const BUS_MONITOR_PATH = path.resolve(__dirname, '../../bus-monitor.ts');

describe('T9: bus-monitor uses SCAN not KEYS', () => {
  let sourceContent: string;

  beforeAll(() => {
    // Read the source file once
    sourceContent = fs.readFileSync(BUS_MONITOR_PATH, 'utf-8');
  });

  test('T9: no redis.keys() calls in bus-monitor.ts', () => {
    // Check for .keys( pattern (indicating redis.keys() call)
    // We use a regex that matches .keys( but not .keyset( or similar
    const keysPattern = /\.keys\s*\(/;
    const matches = sourceContent.match(new RegExp(keysPattern, 'g'));

    // Assert: No redis.keys() calls should exist
    expect(matches).toBeNull();

    // Additional check: ensure SCAN is used instead
    const scanPattern = /\.scan\s*\(/;
    const scanMatches = sourceContent.match(new RegExp(scanPattern, 'g'));

    // SCAN should be present in bus-monitor.ts for agent keys and last-seen keys
    expect(scanMatches).not.toBeNull();
    expect(scanMatches!.length).toBeGreaterThanOrEqual(2);
  });

  test('T9: only contains SCAN calls for Redis key iteration', () => {
    // Verify the pattern is consistent:
    // - agentKeys iteration uses SCAN
    // - lsKeys (lastseen) iteration uses SCAN

    const lines = sourceContent.split('\n');

    // Find all lines with Redis key operations
    const keyOperationLines = lines.filter(line =>
      line.includes('.keys') || line.includes('.scan') || line.includes('MATCH')
    );

    // Each Redis key iteration should use SCAN pattern
    for (const line of keyOperationLines) {
      if (line.includes('.keys')) {
        // If .keys is present, it should be in a comment or variable name, not a call
        expect(line).not.toMatch(/\.keys\s*\(/);
      }
    }
  });

  test('T9: agentKeys and lsKeys both use SCAN pattern', () => {
    // Verify the agentKeys SCAN block exists
    expect(sourceContent).toContain('const agentKeys: string[] = []');
    expect(sourceContent).toContain('.scan(');
    expect(sourceContent).toContain("agent:");

    // Verify the lsKeys SCAN block exists
    expect(sourceContent).toContain('const lsKeys: string[] = []');
    expect(sourceContent).toContain("lastseen:");
  });

  test('T9: production safety check - no blocking KEYS command', () => {
    // This test serves as documentation of the production safety requirement.
    // Redis KEYS command is O(N) and blocks all other commands - never use in production.
    // SCAN is O(1) per call and yields cursor-based iteration for non-blocking operation.

    const keysCommandPattern = /redis\.keys\s*\(/;
    const hasKeysCommand = keysCommandPattern.test(sourceContent);

    expect(hasKeysCommand).toBe(false);
  });
});
