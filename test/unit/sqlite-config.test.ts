/**
 * SQLite Config Placement Tests (T8)
 *
 * Tests for SQLite DB placement behavior and singleton keying.
 * Verifies that the SQLite client creates DB at the correct path
 * and that the singleton is keyed by directory.
 *
 * Tests: T8.1-T8.4
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSqliteClient,
  closeSqliteClient,
  SqliteClient,
} from '../../src/sqlite';

describe('T8: SQLite DB Placement', () => {
  describe('T8.1: DB created at {dbDir}/.agentsynclayer/history.db', () => {
    test('creates .agentsynclayer directory and history.db file', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-placement-'));
      const expectedDbPath = path.join(tempDir, '.agentsynclayer', 'history.db');

      try {
        // Verify DB doesn't exist yet
        expect(fs.existsSync(expectedDbPath)).toBe(false);

        // Call getSqliteClient
        const client = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        expect(client).not.toBeNull();
        expect(client).toBeInstanceOf(SqliteClient);

        // Verify .agentsynclayer directory was created
        expect(fs.existsSync(path.join(tempDir, '.agentsynclayer'))).toBe(true);

        // Verify history.db file was created
        expect(fs.existsSync(expectedDbPath)).toBe(true);

        // Verify the client's getDbPath returns correct path
        expect(client!.getDbPath()).toBe(expectedDbPath);
      } finally {
        closeSqliteClient(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('DB path is correct even when .agentsynclayer exists', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-placement-'));
      const agentsynclayerDir = path.join(tempDir, '.agentsynclayer');
      fs.mkdirSync(agentsynclayerDir, { recursive: true });

      try {
        const client = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        expect(client).not.toBeNull();

        const expectedDbPath = path.join(agentsynclayerDir, 'history.db');
        expect(client!.getDbPath()).toBe(expectedDbPath);
        expect(fs.existsSync(expectedDbPath)).toBe(true);
      } finally {
        closeSqliteClient(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('T8.2: Same db_dir returns same SqliteClient instance', () => {
    test('reference equality for same directory', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-singleton-'));

      try {
        // Get client twice for same directory
        const client1 = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        const client2 = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        const client3 = getSqliteClient(tempDir, 'differentHash');

        // All should be the exact same reference
        expect(client1).toBe(client2);
        expect(client1).toBe(client3);
        expect(client1).not.toBeNull();

        // Even with different hash, it's still the same instance
        // (hash is not used for singleton keying)
      } finally {
        closeSqliteClient(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('client remains the same across multiple calls', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-singleton-'));

      try {
        const clients: SqliteClient[] = [];
        for (let i = 0; i < 5; i++) {
          clients.push(getSqliteClient(tempDir, 'testHash' + i)!);
        }

        // All references should be equal
        for (const client of clients) {
          expect(client).toBe(clients[0]);
        }
      } finally {
        closeSqliteClient(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('T8.3: Different db_dir returns different instances', () => {
    test('different directories get different clients', () => {
      const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-dir1-'));
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-dir2-'));

      try {
        const client1 = getSqliteClient(tempDir1, 'a1b2c3d4e5f6');
        const client2 = getSqliteClient(tempDir2, 'a1b2c3d4e5f6');

        // Different directories should have different instances
        expect(client1).not.toBe(client2);
        expect(client1).not.toBeNull();
        expect(client2).not.toBeNull();

        // Each should have its own DB path
        const dbPath1 = path.join(tempDir1, '.agentsynclayer', 'history.db');
        const dbPath2 = path.join(tempDir2, '.agentsynclayer', 'history.db');
        expect(client1!.getDbPath()).toBe(dbPath1);
        expect(client2!.getDbPath()).toBe(dbPath2);

        // DBs should be different files
        expect(dbPath1).not.toBe(dbPath2);
      } finally {
        closeSqliteClient(tempDir1);
        closeSqliteClient(tempDir2);
        fs.rmSync(tempDir1, { recursive: true, force: true });
        fs.rmSync(tempDir2, { recursive: true, force: true });
      }
    });

    test('symlinked directories get different instances (singleton keyed by raw path)', () => {
      const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-orig-'));
      const linkDir = path.join(os.tmpdir(), 'agentsynclayer-link-' + Date.now());
      fs.symlinkSync(tempDir1, linkDir);

      try {
        const client1 = getSqliteClient(tempDir1, 'a1b2c3d4e5f6');
        const client2 = getSqliteClient(linkDir, 'a1b2c3d4e5f6');

        // SQLite singleton is keyed by raw path, NOT resolved path
        // So symlink and real path get different instances
        expect(client1).not.toBe(client2);

        // Each gets its own DB file in its respective directory
        expect(client1!.getDbPath()).toBe(path.join(tempDir1, '.agentsynclayer', 'history.db'));
        expect(client2!.getDbPath()).toBe(path.join(linkDir, '.agentsynclayer', 'history.db'));
      } finally {
        closeSqliteClient(tempDir1);
        closeSqliteClient(linkDir);
        fs.rmSync(tempDir1, { recursive: true, force: true });
        try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  describe('T8.4: closeSqliteClient removes from map', () => {
    test('after close, next call creates new instance', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-close-'));

      try {
        // First call
        const client1 = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        expect(client1).not.toBeNull();

        // Close it
        closeSqliteClient(tempDir);

        // Next call should create new instance
        const client2 = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        expect(client2).not.toBeNull();

        // Should be a different reference
        expect(client2).not.toBe(client1);

        // Both should still work
        client2!.insertMessage({
          id: 'test-msg',
          from: 'test-agent',
          channel: 'general',
          type: 'info',
          payload: { text: 'test' },
          timestamp: new Date().toISOString(),
          project: 'a1b2c3d4e5f6',
        });

        const { messages } = client2!.getMessages({
          projectHash: 'a1b2c3d4e5f6',
          limit: 10,
          offset: 0,
        });
        expect(messages.length).toBeGreaterThan(0);
      } finally {
        closeSqliteClient(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('close only affects the specified directory', () => {
      const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-dir1-'));
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-dir2-'));

      try {
        // Get clients for both directories
        const client1 = getSqliteClient(tempDir1, 'a1b2c3d4e5f6');
        const client2 = getSqliteClient(tempDir2, 'a1b2c3d4e5f6');

        expect(client1).not.toBe(client2);

        // Close only dir1
        closeSqliteClient(tempDir1);

        // dir1 should get a new client on next call
        const newClient1 = getSqliteClient(tempDir1, 'a1b2c3d4e5f6');
        expect(newClient1).not.toBe(client1);

        // dir2 should still return the same client
        const sameClient2 = getSqliteClient(tempDir2, 'a1b2c3d4e5f6');
        expect(sameClient2).toBe(client2);
      } finally {
        closeSqliteClient(tempDir1);
        closeSqliteClient(tempDir2);
        fs.rmSync(tempDir1, { recursive: true, force: true });
        fs.rmSync(tempDir2, { recursive: true, force: true });
      }
    });

    test('calling close on non-existent client is safe', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsynclayer-noexist-'));

      try {
        // Should not throw
        closeSqliteClient(tempDir);
        closeSqliteClient('/non/existent/path');

        // Creating after close should work normally
        const client = getSqliteClient(tempDir, 'a1b2c3d4e5f6');
        expect(client).not.toBeNull();
      } finally {
        closeSqliteClient(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
