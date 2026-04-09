/**
 * AgentSyncLayer Monitor — External CLI for inspecting and tailing bus state
 *
 * Modes:
 *   bun run bus-monitor.ts                           # One-shot snapshot (default)
 *   bun run bus-monitor.ts --watch [N]               # Refresh every N seconds (default 3)
 *   bun run bus-monitor.ts --follow [channel]        # Live tail via Redis pub/sub
 *   bun run bus-monitor.ts --json                    # Machine-readable JSON output
 *
 * Targeting:
 *   --project /path/to/project                       # Set project dir (hash + default DB path)
 *   --db /path/to/history.db                         # Override SQLite DB file
 *   --channel ch1,ch2                                # Filter output to specific channels
 *   --no-redis                                       # Skip Redis, SQLite only
 */
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import Redis from "ioredis";
import { hashProjectPath } from "./src/namespace";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  project: string | null;
  db: string | null;
  channel: Set<string>;
  watch: number | false;
  follow: string | true | false;
  noRedis: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    project: null,
    db: null,
    channel: new Set(),
    watch: false,
    follow: false,
    noRedis: false,
    json: false,
  };

  let i = 2; // skip bun and script path
  while (i < argv.length) {
    const a = argv[i];
    switch (a) {
      case "--project":
        if (!argv[i + 1]) { console.error("Error: --project requires a path"); process.exit(1); }
        args.project = path.resolve(argv[++i]);
        break;
      case "--db":
        if (!argv[i + 1]) { console.error("Error: --db requires a path"); process.exit(1); }
        args.db = path.resolve(argv[++i]);
        break;
      case "--channel":
        if (!argv[i + 1]) { console.error("Error: --channel requires a comma-separated list"); process.exit(1); }
        for (const ch of argv[++i].split(",")) {
          const trimmed = ch.trim().toLowerCase();
          if (trimmed) args.channel.add(trimmed);
        }
        break;
      case "--watch": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          const n = parseInt(next, 10);
          if (isNaN(n) || n < 1) { console.error("Error: --watch requires a positive integer"); process.exit(1); }
          args.watch = n;
          i++;
        } else {
          args.watch = 3;
        }
        break;
      }
      case "--follow": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args.follow = next.trim().toLowerCase();
          i++;
        } else {
          args.follow = true; // subscribe to all channels
        }
        break;
      }
      case "--no-redis":
        args.noRedis = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        console.error("Usage: bus-monitor.ts [--project <path>] [--db <path>] [--channel ch1,ch2] [--watch [N]] [--follow [channel]] [--no-redis] [--json]");
        process.exit(1);
    }
    i++;
  }

  // Watch and follow are mutually exclusive
  if (args.watch && args.follow) {
    console.error("Error: --watch and --follow are mutually exclusive");
    process.exit(1);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface ResolvedPaths {
  /** Directory used for project hash (canonical) */
  projectDir: string;
  /** Path to the SQLite history.db file */
  dbPath: string;
  /** 12-char hex project hash */
  projectHash: string;
}

function resolvePaths(args: CliArgs): ResolvedPaths {
  let projectDir: string;
  let dbPath: string;

  if (args.db) {
    // --db takes precedence; derive project dir from grandparent (db is at .agentsynclayer/history.db)
    dbPath = args.db;
    const agentsynclayerDir = path.dirname(dbPath);
    projectDir = path.dirname(agentsynclayerDir);
    // If --project also given, use that for the hash instead
    if (args.project) {
      projectDir = args.project;
    }
  } else if (args.project) {
    projectDir = args.project;
    dbPath = path.join(projectDir, ".agentsynclayer", "history.db");
  } else {
    projectDir = process.cwd();
    dbPath = path.join(projectDir, ".agentsynclayer", "history.db");
  }

  // Resolve to canonical path
  let canonical: string;
  try {
    canonical = fs.realpathSync(projectDir);
  } catch {
    canonical = path.resolve(projectDir);
  }

  const projectHash = hashProjectPath(canonical);
  return { projectDir: canonical, dbPath, projectHash };
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const C = {
  dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", magenta: "\x1b[35m",
};

const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const bold = (s: string) => `${C.bold}${s}${C.reset}`;
const cyan = (s: string) => `${C.cyan}${s}${C.reset}`;
const green = (s: string) => `${C.green}${s}${C.reset}`;
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`;
const red = (s: string) => `${C.red}${s}${C.reset}`;
const magenta = (s: string) => `${C.magenta}${s}${C.reset}`;

function getAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

// ---------------------------------------------------------------------------
// Data collection (shared between snapshot and JSON modes)
// ---------------------------------------------------------------------------

interface SnapshotData {
  sqlite: {
    available: boolean;
    dbPath: string;
    messageCount: number;
    channelCount: number;
    ftsCount: number;
    dbSizeBytes: number;
    channels: Array<{ name: string; message_count: number }>;
    recentMessages: Array<{
      channel: string; from: string; type: string;
      payloadPreview: string; created_at: number;
    }>;
  };
  redis: {
    available: boolean;
    cacheChannels: Array<{ name: string; count: number }>;
    agents: Array<{
      id: string; task: string; ttl: number;
      channels: string[];
    }>;
    lastSeens: Array<{
      agentId: string; timestamp: number; ttl: number;
    }>;
  };
}

async function collectSnapshot(
  paths: ResolvedPaths,
  args: CliArgs,
  redis: Redis | null,
): Promise<SnapshotData> {
  const prefix = `opencode:${paths.projectHash}:`;
  const data: SnapshotData = {
    sqlite: {
      available: false, dbPath: paths.dbPath, messageCount: 0, channelCount: 0,
      ftsCount: 0, dbSizeBytes: 0, channels: [], recentMessages: [],
    },
    redis: { available: !!redis, cacheChannels: [], agents: [], lastSeens: [] },
  };

  // --- SQLite ---
  if (fs.existsSync(paths.dbPath)) {
    try {
      const db = new Database(paths.dbPath, { readonly: true });
      data.sqlite.available = true;
      data.sqlite.dbSizeBytes = fs.statSync(paths.dbPath).size;

      const filter = args.channel.size > 0
        ? `WHERE name IN (${Array.from(args.channel).map(() => "?").join(",")})`
        : "";

      data.sqlite.messageCount = args.channel.size > 0
        ? (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE channel IN (${Array.from(args.channel).map(() => "?").join(",")})`).get(...Array.from(args.channel)) as any).n
        : (db.prepare("SELECT COUNT(*) as n FROM messages").get() as any).n;

      data.sqlite.channelCount = (db.prepare("SELECT COUNT(*) as n FROM channels").get() as any).n;
      data.sqlite.ftsCount = (db.prepare("SELECT COUNT(*) as n FROM messages_fts").get() as any).n;

      data.sqlite.channels = args.channel.size > 0
        ? db.prepare(`SELECT name, message_count FROM channels WHERE name IN (${Array.from(args.channel).map(() => "?").join(",")}) ORDER BY message_count DESC`).all(...Array.from(args.channel)) as any[]
        : db.prepare("SELECT name, message_count FROM channels ORDER BY message_count DESC").all() as any[];

      const recentQuery = args.channel.size > 0
        ? `SELECT channel, "from", type, substr(payload, 1, 80), created_at FROM messages WHERE channel IN (${Array.from(args.channel).map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 10`
        : `SELECT channel, "from", type, substr(payload, 1, 80), created_at FROM messages ORDER BY created_at DESC LIMIT 10`;

      const recentRows = args.channel.size > 0
        ? db.prepare(recentQuery).all(...Array.from(args.channel)) as any[]
        : db.prepare(recentQuery).all() as any[];

      data.sqlite.recentMessages = recentRows.map((r: any) => ({
        channel: r.channel,
        from: r.from,
        type: r.type,
        payloadPreview: r["substr(payload, 1, 80)"],
        created_at: r.created_at,
      }));

      db.close();
    } catch (err) {
      data.sqlite.available = false;
      console.error(`SQLite error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --- Redis ---
  if (redis) {
    try {
      const chSet = await redis.smembers(`${prefix}channels`);
      const filteredChs = args.channel.size > 0
        ? chSet.filter(c => args.channel.has(c))
        : chSet;

      for (const ch of filteredChs) {
        const count = await redis.zcard(`${prefix}history:${ch}`);
        data.redis.cacheChannels.push({ name: ch, count });
        }

      const agentKeys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}agent:*`, 'COUNT', 100);
        cursor = nextCursor;
        agentKeys.push(...keys);
      } while (cursor !== '0');
      for (const key of agentKeys) {
        const [dataStr, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
        if (!dataStr) continue;
        try {
          const p = JSON.parse(dataStr);
          data.redis.agents.push({
            id: key.split(":").pop()!,
            task: p.task ?? "",
            ttl,
            channels: p.channels ?? [],
          });
        } catch { /* skip malformed */ }
        }

      const lsKeys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}lastseen:*`, 'COUNT', 100);
        cursor = nextCursor;
        lsKeys.push(...keys);
      } while (cursor !== '0');
      for (const key of lsKeys) {
        const [tsStr, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
        data.redis.lastSeens.push({
          agentId: key.split(":").pop()!,
          timestamp: tsStr ? parseInt(tsStr, 10) : 0,
          ttl,
        });
      }
    } catch (err) {
      console.error(`Redis query error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return data;
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

function renderSnapshot(paths: ResolvedPaths, data: SnapshotData): void {
  console.log(bold("╔══ AgentSyncLayer Monitor ═══"));
  console.log(dim(`  project: ${paths.projectDir}`));
  console.log(dim(`  hash:    ${paths.projectHash}`));
  console.log(dim(`  db:      ${data.sqlite.dbPath}`));
  if (data.sqlite.available) console.log(dim(`  redis:   ${data.redis.available ? green("connected") : yellow("unavailable")}`));
  else console.log(dim(`  redis:   ${data.redis.available ? green("connected") : yellow("unavailable")}`));
  console.log();

  // --- SQLite ---
  if (data.sqlite.available) {
    console.log(bold("  SQLite"));
    console.log(`    Messages:      ${green(String(data.sqlite.messageCount))}`);
    console.log(`    Channels:      ${cyan(String(data.sqlite.channelCount))}`);
    console.log(`    FTS5 entries:  ${String(data.sqlite.ftsCount)}`);
    console.log(`    DB size:       ${dim((data.sqlite.dbSizeBytes / 1024).toFixed(1) + " KB")}`);

    if (data.sqlite.channels.length > 0) {
      console.log();
      console.log(bold("  Channels"));
      const w = Math.max(...data.sqlite.channels.map(c => c.name.length), 8);
      for (const ch of data.sqlite.channels) {
        const bar = "\u2588".repeat(Math.min(ch.message_count, 40));
        console.log(`    ${ch.name.padEnd(w + 2)} ${cyan(String(ch.message_count).padStart(4))} ${dim(bar)}`);
      }
    }

    if (data.sqlite.recentMessages.length > 0) {
      console.log();
      console.log(bold("  Recent Messages"));
      for (const msg of data.sqlite.recentMessages) {
        const ago = getAgo(msg.created_at);
        console.log(
          `    ${dim(ago.padEnd(10))} ${cyan(msg.channel.padEnd(10))} ${dim("[" + msg.type.padEnd(11) + "]")} ${msg.from.slice(0, 16)}  ${dim(msg.payloadPreview)}`
        );
      }
    }
  } else {
    console.log(dim("  SQLite: database not found or unreadable"));
  }
  console.log();

  // --- Redis ---
  if (data.redis.available) {
    if (data.redis.cacheChannels.length > 0) {
      console.log(bold("  Redis Cache"));
      const w = Math.max(...data.redis.cacheChannels.map(c => c.name.length), 8);
      for (const ch of data.redis.cacheChannels) {
        const bar = "\u2588".repeat(Math.min(ch.count, 40));
        console.log(`    ${ch.name.padEnd(w + 2)} ${cyan(String(ch.count).padStart(4))} ${dim(bar)}`);
      }
      console.log();
    }

    const liveAgents = data.redis.agents.filter(a => a.ttl > 0);
    if (liveAgents.length > 0) {
      console.log(bold("  Active Agents"));
      for (const a of liveAgents) {
        console.log(`    ${green("\u25CF")} ${cyan(a.id.slice(0, 24))}  ${dim(a.task.slice(0, 50))}  ${dim(Math.round(a.ttl) + "s")}`);
        if (a.channels.length) {
          console.log(`    ${"".padEnd(30)}channels: [${a.channels.join(", ")}]`);
        }
      }
      console.log();
    }

    const activeLS = data.redis.lastSeens.filter(l => l.ttl > 0);
    if (activeLS.length > 0) {
      console.log(bold("  Last-Seen Timestamps"));
      for (const l of activeLS) {
        const ago = l.timestamp > 0 ? getAgo(l.timestamp) : "never";
        console.log(`    ${cyan(l.agentId.slice(0, 24))}  last seen: ${dim(ago.padEnd(12))} ${dim(Math.round(l.ttl) + "s left")}`);
      }
      console.log();
    }
  }

  console.log(bold("────────────────────"));
}

// ---------------------------------------------------------------------------
// Follow mode (Redis pub/sub live tail)
// ---------------------------------------------------------------------------

async function followMode(
  paths: ResolvedPaths,
  args: CliArgs,
  redis: Redis,
): Promise<void> {
  const prefix = `opencode:${paths.projectHash}:`;
  let running = true;

  // ioredis needs a dedicated connection for subscribing
  const sub = new Redis(process.env.AGENTSYNCLAYER_REDIS_URL ?? "redis://localhost:6379/0", {
    lazyConnect: true, connectTimeout: 3000, retryStrategy: () => null, maxRetriesPerRequest: 0,
  });

  const cleanup = () => {
    if (!running) return;
    running = false;
    sub.unsubscribe().catch(() => {});
    sub.disconnect();
    redis.disconnect();
    console.log("\n" + dim("Stopped following."));
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await sub.connect();
  } catch {
    console.error(red("Failed to connect Redis for pub/sub. Cannot follow."));
    await redis.disconnect();
    return;
  }

  // Determine which channels to subscribe to
  let channelsToSubscribe: string[];
  // Always include __status__ so status updates are visible in follow mode
  const statusChannel = `${prefix}ch:__status__`;
  const claimsChannel = `${prefix}ch:claims`;

  if (args.follow === true) {
    // All channels — discover from Redis set or use filter
    if (args.channel.size > 0) {
      channelsToSubscribe = Array.from(args.channel).map(ch => `${prefix}ch:${ch}`);
    } else {
      const known = await redis.smembers(`${prefix}channels`);
      if (known.length > 0) {
        channelsToSubscribe = known.map(ch => `${prefix}ch:${ch}`);
      } else {
        console.log(yellow("No channels discovered. Waiting for first message on any project channel..."));
        // Subscribe to pattern as fallback
        await sub.psubscribe(`${prefix}ch:*`);
        channelsToSubscribe = [];
      }
    }
  } else {
    // Specific channel
    channelsToSubscribe = [`${prefix}ch:${args.follow}`];
  }

  // Add system channels (avoid duplicates)
  for (const sysCh of [statusChannel, claimsChannel]) {
    if (!channelsToSubscribe.includes(sysCh)) {
      channelsToSubscribe.push(sysCh);
    }
  }

  if (channelsToSubscribe.length > 0) {
    for (const ch of channelsToSubscribe) {
      await sub.subscribe(ch);
    }
    const labels = channelsToSubscribe.map(ch => ch.split(":").pop());
    console.log(bold(`Following: [${labels.join(", ")}]`));
  }

  console.log(dim("Press Ctrl+C to stop.\n"));

  // Print header
  const header = `${dim("TIME".padEnd(10))} ${cyan("CHANNEL".padEnd(12))} ${dim("TYPE".padEnd(12))} ${dim("FROM")}`;
  console.log(header);
  console.log(dim("─".repeat(70)));

  sub.on("message", (_ch: string, msgStr: string) => {
    if (!running) return;
    try {
      const msg = JSON.parse(msgStr);
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const payloadText = typeof msg.payload === "string"
        ? msg.payload
        : (msg.payload?.text ?? JSON.stringify(msg.payload).slice(0, 80));

      console.log(
        `${dim(time.padEnd(10))} ${cyan((msg.channel ?? "").padEnd(12))} ${dim((msg.type ?? "info").padEnd(12))} ${(msg.from ?? "").slice(0, 20)}  ${payloadText.slice(0, 120)}`
      );
    } catch {
      // Non-JSON message, print raw
      console.log(dim(msgStr.slice(0, 120)));
    }
  });

  // Pattern subscriber for "follow all" fallback
  sub.on("pmessage", (_pattern: string, _ch: string, msgStr: string) => {
    if (!running) return;
    try {
      const msg = JSON.parse(msgStr);
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const payloadText = typeof msg.payload === "string"
        ? msg.payload
        : (msg.payload?.text ?? JSON.stringify(msg.payload).slice(0, 80));

      console.log(
        `${dim(time.padEnd(10))} ${cyan((msg.channel ?? "").padEnd(12))} ${dim((msg.type ?? "info").padEnd(12))} ${(msg.from ?? "").slice(0, 20)}  ${payloadText.slice(0, 120)}`
      );
    } catch {
      console.log(dim(msgStr.slice(0, 120)));
    }
  });

  sub.on("error", (err) => {
    if (running) console.error(red(`Pub/sub error: ${err.message}`));
  });

  // Keep alive until signal
  await new Promise<void>(resolve => {
    const check = setInterval(() => { if (!running) { clearInterval(check); resolve(); } }, 500);
  });
}

// ---------------------------------------------------------------------------
// Redis connection helper
// ---------------------------------------------------------------------------

async function connectRedis(): Promise<Redis | null> {
  const redis = new Redis(process.env.AGENTSYNCLAYER_REDIS_URL ?? "redis://localhost:6379/0", {
    lazyConnect: true, connectTimeout: 3000, retryStrategy: () => null, maxRetriesPerRequest: 0,
  });
  try {
    await redis.connect();
    return redis;
  } catch {
    await redis.disconnect();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const paths = resolvePaths(args);

  // --- Follow mode (exits on its own via Ctrl+C) ---
  if (args.follow) {
    if (args.noRedis) {
      console.error("Error: --follow requires Redis (cannot use --no-redis)");
      process.exit(1);
    }

    const redis = await connectRedis();
    if (!redis) {
      console.error(red("Cannot connect to Redis. Follow mode requires a live Redis connection."));
      process.exit(1);
    }

    await followMode(paths, args, redis);
    return;
  }

  // --- Snapshot mode (once or watch) ---
  const redis = args.noRedis ? null : await connectRedis();

  if (args.watch) {
    // Watch mode: periodic refresh
    let iteration = 0;
    const interval = setInterval(async () => {
      iteration++;
      clearScreen();
      const ts = new Date().toISOString().slice(11, 19);
      console.log(dim(`refresh: ${ts}  interval: ${args.watch}s  (#${iteration})`));
      console.log();

      const data = await collectSnapshot(paths, args, redis);
      if (args.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        renderSnapshot(paths, data);
      }
    }, args.watch * 1000);

    // First render immediately
    clearScreen();
    const data = await collectSnapshot(paths, args, redis);
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      renderSnapshot(paths, data);
    }

    // Graceful shutdown
    const stop = () => {
      clearInterval(interval);
      if (redis) redis.disconnect();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    // One-shot mode
    const data = await collectSnapshot(paths, args, redis);
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      renderSnapshot(paths, data);
    }
    if (redis) await redis.disconnect();
  }
}

main().catch(console.error);
