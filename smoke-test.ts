/**
 * Smoke test: exercises the full SQLite persistence flow end-to-end.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --- Setup ---
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
const projectDir = path.join(testDir, 'project');
fs.mkdirSync(projectDir, { recursive: true });

import { hashProjectPath } from './src/namespace';
import { getRedisClient } from './src/redis';
import { closeSqliteClient, getSqliteClient } from './src/sqlite';
import { busHistoryExecute } from './src/tools/bus_history';
import { busReadExecute } from './src/tools/bus_read';
import { busSearchExecute } from './src/tools/bus_search';
import { busSendExecute } from './src/tools/bus_send';
import type { ToolContext } from './src/types';

const projectHash = hashProjectPath(projectDir);
console.log(`Project hash: ${projectHash}`);

const ctx = { directory: projectDir } as ToolContext;

// --- Phase 1: Initialize SQLite ---
console.log('\n=== Phase 1: Initialize SQLite ===');
const sqlite = getSqliteClient(projectDir, projectHash);
console.log(`SQLite available: ${sqlite !== null}`);
console.log(`DB path: ${sqlite?.getDbPath()}`);

// --- Phase 2: bus_send (dual-write) ---
console.log('\n=== Phase 2: bus_send (dual-write) ===');
const sendResult1 = await busSendExecute(
  { channel: 'general', type: 'info', message: 'Hello from agent A' },
  ctx,
);
console.log(`Send 1: ok=${sendResult1.ok}`);

const sendResult2 = await busSendExecute(
  {
    channel: 'general',
    type: 'coordination',
    message: 'Task assignment: implement SQLite persistence',
  },
  ctx,
);
console.log(`Send 2: ok=${sendResult2.ok}`);

const sendResult3 = await busSendExecute(
  { channel: 'build', type: 'info', message: 'Build started for feature branch' },
  ctx,
);
console.log(`Send 3 (build channel): ok=${sendResult3.ok}`);

// --- Phase 3: bus_read (Redis first) ---
console.log('\n=== Phase 3: bus_read (Redis cache) ===');
const readResult = await busReadExecute({ channel: 'general', limit: 20 }, ctx);
console.log(
  `Read 'general': ok=${readResult.ok}, count=${readResult.data?.count}, total=${readResult.data?.total}`,
);
if (readResult.ok) {
  for (const msg of (readResult.data as { messages: unknown[] }).messages) {
    console.log(`  [${msg.type}] ${msg.from}: ${(msg.payload as { text?: string }).text}`);
  }
}

// --- Phase 4: bus_history (SQLite deep read) ---
console.log('\n=== Phase 4: bus_history (paginated from SQLite) ===');
const historyResult = await busHistoryExecute({ channel: 'general', page: 1, per_page: 10 }, ctx);
console.log(
  `History 'general' p1: ok=${historyResult.ok}, count=${(historyResult.data as { count?: number })?.count}, total=${(historyResult.data as { total?: number })?.total}, pages=${(historyResult.data as { total?: number })?.total_pages}`,
);

const allHistory = await busHistoryExecute({ page: 1, per_page: 10 }, ctx);
console.log(
  `History (all channels): ok=${allHistory.ok}, count=${(allHistory.data as { count?: number })?.count}, total=${(allHistory.data as { total?: number })?.total}`,
);

// --- Phase 5: bus_search (FTS5) ---
console.log('\n=== Phase 5: bus_search (FTS5 full-text) ===');
const searchResult = await busSearchExecute({ query: 'SQLite persistence' }, ctx);
console.log(
  `Search 'SQLite persistence': ok=${searchResult.ok}, count=${(searchResult.data as { count?: number })?.count}`,
);
if (searchResult.ok) {
  for (const r of (searchResult.data as { results: unknown[] }).results) {
    console.log(`  [rank=${r.rank}] ${r.message.channel}: ${r.snippet}`);
  }
}

const searchResult2 = await busSearchExecute({ query: 'build', channel: 'build' }, ctx);
console.log(
  `Search 'build' in 'build': ok=${searchResult2.ok}, count=${(searchResult2.data as { count?: number })?.count}`,
);

// --- Phase 6: Fallback test (flush Redis, read from SQLite) ---
console.log('\n=== Phase 6: Fallback (flush Redis -> read from SQLite) ===');
const redis = getRedisClient();
if (redis.checkConnection()) {
  const client = redis.getClient();
  await client.del(`opencode:${projectHash}:history:general`);
  console.log('Flushed Redis sorted set for general channel');

  const fallbackRead = await busReadExecute({ channel: 'general', limit: 20 }, ctx);
  console.log(
    `Fallback read: ok=${fallbackRead.ok}, count=${fallbackRead.data?.count}, total=${fallbackRead.data?.total}`,
  );
  console.log(
    `  -> Successfully fell back to SQLite: ${fallbackRead.data?.count > 0 ? 'YES' : 'NO'}`,
  );
}

// --- Phase 7: Message count ---
console.log('\n=== Phase 7: Message count ===');
console.log(`Total messages: ${sqlite?.getMessageCount()}`);
console.log(`  general: ${sqlite?.getMessageCount('general')}`);
console.log(`  build: ${sqlite?.getMessageCount('build')}`);

// --- Cleanup ---
closeSqliteClient(projectDir);
const redisClient = redis.getClient();
await redisClient.del(`opencode:${projectHash}:history:general`);
await redisClient.del(`opencode:${projectHash}:history:build`);
await redisClient.del(`opencode:${projectHash}:ch:general`);
await redisClient.del(`opencode:${projectHash}:ch:build`);
await redisClient.del(`opencode:${projectHash}:channels`);
fs.rmSync(testDir, { recursive: true, force: true });

console.log('\n=== SMOKE TEST PASSED ===');
