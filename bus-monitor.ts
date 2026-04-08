/**
 * AgentBus Monitor — External CLI for inspecting bus state
 *
 * Usage: bun run bus-monitor.ts
 */
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import Redis from "ioredis";
import { createHash } from "crypto";

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };
const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const bold = (s: string) => `${C.bold}${s}${C.reset}`;
const cyan = (s: string) => `${C.cyan}${s}${C.reset}`;
const green = (s: string) => `${C.green}${s}${C.reset}`;
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`;

function getAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function main() {
  const dbPath = path.join(process.cwd(), ".agentbus", "history.db");
  const projectHash = createHash("sha256").update(path.resolve(process.cwd())).digest("hex").slice(0, 12);
  const prefix = `opencode:${projectHash}:`;

  console.log(bold("╔══ AgentBus Monitor ═══"));
  console.log(dim(`  project: ${process.cwd()}`));
  console.log(dim(`  hash:    ${projectHash}`));
  console.log(dim(`  db:      ${dbPath}`));
  console.log();

  // --- Redis ---
  let redis: Redis | null = null;
  try {
    redis = new Redis(process.env.AGENTBUS_REDIS_URL ?? "redis://localhost:6379/0", {
      lazyConnect: true, connectTimeout: 3000, retryStrategy: () => null, maxRetriesPerRequest: 0,
    });
    await redis.connect();
    console.log(dim(`  redis:   connected`));
  } catch {
    console.log(yellow("  redis:   unavailable"));
  }
  console.log();

  // --- SQLite ---
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    const msgCount = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as any).n;
    const chCount = (db.prepare("SELECT COUNT(*) as n FROM channels").get() as any).n;
    const ftsCount = (db.prepare("SELECT COUNT(*) as n FROM messages_fts").get() as any).n;
    const dbSize = fs.statSync(dbPath).size;

    console.log(bold("  SQLite"));
    console.log(`    Messages:      ${green(String(msgCount))}`);
    console.log(`    Channels:      ${cyan(String(chCount))}`);
    console.log(`    FTS5 entries:  ${String(ftsCount)}`);
    console.log(`    DB size:       ${dim((dbSize / 1024).toFixed(1) + " KB")}`);

    const channels = db.prepare("SELECT name, message_count FROM channels ORDER BY message_count DESC").all() as any[];
    if (channels.length > 0) {
      console.log();
      console.log(bold("  Channels"));
      const w = Math.max(...channels.map((c: any) => c.name.length), 8);
      for (const ch of channels) {
        const bar = "\u2588".repeat(Math.min(ch.message_count, 40));
        console.log(`    ${ch.name.padEnd(w + 2)} ${cyan(String(ch.message_count).padStart(4))} ${dim(bar)}`);
      }
    }

    const recent = db.prepare(
      `SELECT channel, "from", type, substr(payload, 1, 80), created_at FROM messages ORDER BY created_at DESC LIMIT 10`
    ).all() as any[];
    if (recent.length > 0) {
      console.log();
      console.log(bold("  Recent Messages"));
      for (const msg of recent) {
        const ago = getAgo(msg.created_at);
        const preview = msg["substr(payload, 1, 80)"];
        console.log(`    ${dim(ago.padEnd(10))} ${cyan(msg.channel.padEnd(10))} ${dim("[" + msg.type.padEnd(11) + "]")} ${msg["from"].slice(0, 16)}  ${dim(preview)}`);
      }
    }
    db.close();
    console.log();
  } else {
    console.log(dim("  SQLite: no database found"));
    console.log();
  }

  // --- Redis state ---
  if (redis) {
    const chSet = await redis.smembers(`${prefix}channels`);
    const chCache = [];
    for (const ch of chSet) {
      const count = await redis.zcard(`${prefix}history:${ch}`);
      chCache.push({ name: ch, count });
    }

    const agentKeys = await redis.keys(`${prefix}agent:*`);
    const agents = [];
    for (const key of agentKeys) {
      const data = await redis.get(key);
      const ttl = await redis.ttl(key);
      if (!data) continue;
      try {
        const p = JSON.parse(data);
        agents.push({ id: key.split(":").pop(), task: p.task, ttl, channels: p.channels ?? [] });
      } catch { /* skip */ }
    }

    const lsKeys = await redis.keys(`${prefix}lastseen:*`);
    const lastSeens = [];
    for (const key of lsKeys) {
      const ts = await redis.get(key);
      const ttl = await redis.ttl(key);
      const agentId = key.split(":").pop();
      lastSeens.push({ agentId, timestamp: ts ? parseInt(ts) : 0, ttl });
    }

    if (chCache.length > 0) {
      console.log(bold("  Redis Cache"));
      const w = Math.max(...chCache.map((c: any) => c.name.length), 8);
      for (const ch of chCache) {
        const bar = "\u2588".repeat(Math.min(ch.count, 40));
        console.log(`    ${ch.name.padEnd(w + 2)} ${cyan(String(ch.count).padStart(4))} ${dim(bar)}`);
      }
      console.log();
    }

    const liveAgents = agents.filter((a: any) => a && a.ttl > 0);
    if (liveAgents.length > 0) {
      console.log(bold("  Active Agents"));
      for (const a of liveAgents) {
        console.log(`    ${green("\u25CF")} ${cyan((a.id as string).slice(0, 24))}  ${dim((a.task ?? "").slice(0, 50))}  ${dim(Math.round(a.ttl) + "s")}`);
        if (a.channels.length) {
          console.log(`    ${"".padEnd(30)}channels: [${a.channels.join(", ")}]`);
        }
      }
      console.log();
    }

    const activeLS = lastSeens.filter((l: any) => l.ttl > 0);
    if (activeLS.length > 0) {
      console.log(bold("  Last-Seen Timestamps"));
      for (const l of activeLS) {
        const ago = l.timestamp > 0 ? getAgo(l.timestamp) : "never";
        console.log(`    ${cyan((l.agentId as string).slice(0, 24))}  last seen: ${dim(ago.padEnd(12))} ${dim(Math.round(l.ttl) + "s left")}`);
      }
      console.log();
    }

    await redis.disconnect();
  }

  console.log(bold("────────────────────"));
}

main().catch(console.error);
