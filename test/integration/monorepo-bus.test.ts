/**
 * Monorepo Cross-Directory Communication Tests (I1)
 *
 * Tests that agents in different subdirectories of a monorepo
 * can communicate when they share a .agentsynclayer.json config.
 *
 * Tests: I1.1-I1.4
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBusConfig } from '../../src/config';
import { resetSessionAgentId, setSessionAgentId } from '../../src/session';
import {
  busAgentsExecute,
  busClaimExecute,
  busHistoryExecute,
  busReadExecute,
  busSendExecute,
  busStatusExecute,
  cleanupRateLimiter,
} from '../../src/tools';
import {
  createTestContext,
  createTestDirTree,
  generateTestAgentId,
  isRedisAvailable,
} from '../helpers';

describe('I1: Monorepo Cross-Directory Communication', () => {
  const ctx = createTestContext();

  beforeAll(async () => {
    const available = await isRedisAvailable();
    if (!available) {
      throw new Error('Redis is not available. Please start Redis server on localhost:6379');
    }
    await ctx.setup();
  });

  afterAll(async () => {
    cleanupRateLimiter();
    await ctx.teardown();
  });

  beforeEach(() => {
    resetSessionAgentId();
  });

  afterEach(() => {
    resetSessionAgentId();
  });

  describe('I1.1: Cross-directory message exchange', () => {
    test('agent in sub1 can send message that agent in sub2 can read', async () => {
      // Create monorepo structure with shared config
      const { root, sub1, sub2, cleanup } = createTestDirTree();
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const agent1Id = generateTestAgentId('mono1');
      const agent2Id = generateTestAgentId('mono2');

      try {
        // Verify config resolves to same projectHash
        const config1 = resolveBusConfig(sub1);
        const config2 = resolveBusConfig(sub2);
        expect(config1.projectHash).toBe(config2.projectHash);
        expect(config1.source).toBe('config');

        // Agent 1 sends a message
        setSessionAgentId(agent1Id);
        const sendResult = await busSendExecute(
          { channel: 'general', message: 'Hello from API package!' },
          { directory: sub1 },
        );

        expect(sendResult.ok).toBe(true);
        expect(sendResult.data).toBeDefined();

        // Agent 2 reads the message
        setSessionAgentId(agent2Id);
        const readResult = await busReadExecute(
          { channel: 'general', limit: 10 },
          { directory: sub2 },
        );

        expect(readResult.ok).toBe(true);
        expect(readResult.data).toBeDefined();
        expect(readResult.data!.messages.length).toBeGreaterThan(0);

        // Verify the message content
        const messageFromAgent1 = readResult.data!.messages.find((m) => m.from === agent1Id);
        expect(messageFromAgent1).toBeDefined();
        expect(messageFromAgent1!.payload).toEqual({ text: 'Hello from API package!' });
      } finally {
        cleanup();
      }
    });

    test('agent in sub2 can send reply that agent in sub1 can read', async () => {
      const { root, sub1, sub2, cleanup } = createTestDirTree();
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const agent1Id = generateTestAgentId('mono1');
      const agent2Id = generateTestAgentId('mono2');

      try {
        // Agent 2 sends a reply
        setSessionAgentId(agent2Id);
        const replyResult = await busSendExecute(
          { channel: 'general', message: 'Reply from Web package!' },
          { directory: sub2 },
        );

        expect(replyResult.ok).toBe(true);

        // Agent 1 reads both messages
        setSessionAgentId(agent1Id);
        const readResult = await busReadExecute(
          { channel: 'general', limit: 10 },
          { directory: sub1 },
        );

        expect(readResult.ok).toBe(true);

        // Should see message from agent 2
        const hasWebReply = readResult.data!.messages.some(
          (m) => m.from === agent2Id && (m.payload as any).text === 'Reply from Web package!',
        );
        expect(hasWebReply).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe('I1.2: Agent visibility across directories', () => {
    test('both agents see each other in bus_agents', async () => {
      const { root, sub1, sub2, cleanup } = createTestDirTree();
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const agent1Id = generateTestAgentId('mono1');
      const agent2Id = generateTestAgentId('mono2');

      try {
        // Register agent 1's status
        setSessionAgentId(agent1Id);
        await busStatusExecute(
          { task: 'Working on API', files: ['api.ts'], channels: ['general'] },
          { directory: sub1 },
        );

        // Register agent 2's status
        setSessionAgentId(agent2Id);
        await busStatusExecute(
          { task: 'Working on Web', files: ['web.ts'], channels: ['general'] },
          { directory: sub2 },
        );

        // Give Redis time to propagate
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Query agents from agent 1's context
        setSessionAgentId(agent1Id);
        const agentsResult1 = await busAgentsExecute({}, { directory: sub1 });

        expect(agentsResult1.ok).toBe(true);

        const agentIds = agentsResult1.data!.agents.map((a) => a.id);
        expect(agentIds).toContain(agent1Id);
        expect(agentIds).toContain(agent2Id);
      } finally {
        cleanup();
      }
    });
  });

  describe('I1.3: File claims visible across directories', () => {
    test('claim from sub1 visible to sub2', async () => {
      const { root, sub1, sub2, cleanup } = createTestDirTree();
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const agent1Id = generateTestAgentId('mono1');
      const agent2Id = generateTestAgentId('mono2');

      try {
        // Agent 1 claims a file from sub1
        setSessionAgentId(agent1Id);
        const claimResult = await busClaimExecute(
          { path: 'packages/api/src/main.ts' },
          { directory: sub1 },
        );

        expect(claimResult.ok).toBe(true);
        expect(claimResult.data!.path).toBe('packages/api/src/main.ts');

        // Agent 2 tries to claim the same file from sub2
        setSessionAgentId(agent2Id);
        const conflictResult = await busClaimExecute(
          { path: 'packages/api/src/main.ts' },
          { directory: sub2 },
        );

        // Should get conflict (agent 1 already has it)
        expect(conflictResult.ok).toBe(false);
        expect(conflictResult.code).toBe('CLAIM_CONFLICT');
      } finally {
        cleanup();
      }
    });

    test('different files can be claimed independently', async () => {
      const { root, sub1, sub2, cleanup } = createTestDirTree();
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const agent1Id = generateTestAgentId('mono1');
      const agent2Id = generateTestAgentId('mono2');

      try {
        // Agent 1 claims file 1
        setSessionAgentId(agent1Id);
        const claim1 = await busClaimExecute(
          { path: 'packages/api/src/file1.ts' },
          { directory: sub1 },
        );
        expect(claim1.ok).toBe(true);

        // Agent 2 claims file 2
        setSessionAgentId(agent2Id);
        const claim2 = await busClaimExecute(
          { path: 'packages/web/src/file2.ts' },
          { directory: sub2 },
        );
        expect(claim2.ok).toBe(true);

        // Both can claim successfully
        expect(claim1.data!.path).toBe('packages/api/src/file1.ts');
        expect(claim2.data!.path).toBe('packages/web/src/file2.ts');
      } finally {
        cleanup();
      }
    });
  });

  describe('I1.4: History visible across directories', () => {
    test('bus_history returns messages from both agents', async () => {
      const { root, sub1, sub2, cleanup } = createTestDirTree();
      fs.writeFileSync(path.join(root, '.agentsynclayer.json'), JSON.stringify({ bus: '.' }));

      const agent1Id = generateTestAgentId('mono1');
      const agent2Id = generateTestAgentId('mono2');

      try {
        // Send messages from agent 1
        setSessionAgentId(agent1Id);
        await busSendExecute(
          { channel: 'coordination', message: 'Coordination message from agent 1' },
          { directory: sub1 },
        );

        // Send messages from agent 2
        setSessionAgentId(agent2Id);
        await busSendExecute(
          { channel: 'coordination', message: 'Coordination message from agent 2' },
          { directory: sub2 },
        );

        // Read history from agent 1's context
        setSessionAgentId(agent1Id);
        const historyResult = await busHistoryExecute(
          { channel: 'coordination', page: 1, per_page: 10 },
          { directory: sub1 },
        );

        expect(historyResult.ok).toBe(true);
        expect(historyResult.data!.messages.length).toBeGreaterThanOrEqual(2);

        // Verify both agents' messages are present
        const messageTexts = historyResult.data!.messages.map((m) => (m.payload as any).text);
        expect(messageTexts).toContain('Coordination message from agent 1');
        expect(messageTexts).toContain('Coordination message from agent 2');
      } finally {
        cleanup();
      }
    });
  });
});
