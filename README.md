# AgentSyncLayer

**Redis + SQLite pub/sub messaging plugin for OpenCode agent coordination**

Version 0.9.2

---

AgentSyncLayer enables multiple OpenCode AI agent sessions running on the same project to communicate and coordinate with each other. It provides a message bus for broadcasting status updates, advisory file claims to prevent conflicting edits, and real-time coordination between agents—all backed by Redis for persistence and low-latency delivery.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Usage Examples](#usage-examples)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Overview

When running multiple OpenCode agents on the same project, they operate in isolation—Agent A may refactor a file while Agent B simultaneously adds a feature that imports from it. AgentSyncLayer solves this by providing:

- **Presence awareness** — Agents announce what they're working on
- **File coordination** — Advisory claims prevent simultaneous edits to the same file
- **Message broadcasting** — Channels for status updates, errors, and coordination
- **Automatic project isolation** — Messages stay scoped to their project via path-derived namespaces
- **Graceful degradation** — Agents continue working if Redis is unavailable

### What AgentSyncLayer Is Not

- **Not a task orchestrator** — No automatic task assignment or work stealing
- **Not a mandatory lock system** — Claims are advisory; agents can ignore them
- **Not cross-machine** — v1 targets localhost only (same developer, same machine)
- **Not a persistent archive** — Message history is capped at 100 messages per channel

---

## Features

AgentSyncLayer provides 11 tools for agent coordination:

### Messaging

| Tool | Description |
|------|-------------|
| `bus_send` | Publish a message to a channel |
| `bus_read` | Read recent messages from a channel |
| `bus_channels` | List all active channels in the project |
| `bus_listen` | Long-poll for new messages (waits until arrival or timeout) |
| `bus_history` | Read paginated deep message history from SQLite |
| `bus_search` | Full-text search across message history |

### Coordination

| Tool | Description |
|------|-------------|
| `bus_status` | Update your agent's status (task, files, channels) |
| `bus_agents` | List all active agents in the project |
| `bus_info` | Get resolved bus configuration (bus directory, project hash, config source) |

### File Claims

| Tool | Description |
|------|-------------|
| `bus_claim` | Claim a file for editing (advisory lock) |
| `bus_release` | Release a file claim |

---

## Requirements

### Runtime

- **Redis** ≥ 6.0 (localhost on port 6379 by default)
- **OpenCode** plugin-compatible environment

### Development (optional)

- **Bun** ≥ 1.0.0 (for running tests, local development)
- Note: OpenCode automatically installs NPM plugin dependencies via Bun

---

## Quick Start

Add `opencode-asl` to the `plugin` array in your OpenCode config:

```json
{
  "plugin": ["opencode-asl"]
}
```

Place this in `~/.config/opencode/opencode.json` (global) or `opencode.json` in your project root (project-level). OpenCode will download and install the plugin automatically — no manual `npm install` needed.

Requires **Redis ≥ 6.0** running on localhost:6379 (or configure a custom URL in [Configuration](#configuration)).

## Installation

### 1. Start Redis

If Redis isn't running, start it:

```bash
# macOS (with Homebrew)
brew services start redis

# Ubuntu/Debian
sudo systemctl start redis-server

# Docker
docker run -d -p 6379:6379 redis:latest
```

Verify Redis is running:

```bash
redis-cli ping
# Should return: PONG
```

### 2. Verify Plugin Loaded

In OpenCode, run:

```bash
bus_info()
```

Should return configuration including project hash and bus directory.

---

## Configuration

AgentSyncLayer has three configurable options. Each can be set via environment variable, config file, or left at its default. They are resolved **independently** — mix and match any combination.

| Option | What it controls | Env var | Config key | Default |
|--------|-----------------|---------|------------|---------|
| **Redis URL** | Where the Redis server is | `AGENTSYNCLAYER_REDIS_URL` | `redis` | `redis://localhost:6379` |
| **Bus directory** | Which project namespace agents share | `AGENTSYNCLAYER_BUS_DIR` | `bus` | Current working directory |
| **DB directory** | Where SQLite history is stored | `AGENTSYNCLAYER_DB_DIR` | `db` | Same as bus directory |

### Understanding bus_dir vs db_dir

These are separate because they serve different purposes:

- **Bus directory** determines the **project hash** — a 12-character hex string derived from the directory path. This hash is used as the Redis key prefix, so agents in different directories can't see each other's messages. Setting this to a shared path (e.g., `/mono/root`) lets multiple worktrees or packages share a single namespace.

- **DB directory** determines where the **SQLite history database** is written. Defaults to the bus directory, but can be pointed elsewhere if you want shared messaging with separate history storage.

In most setups they're the same directory and you don't need to think about it. Override them independently only when you have a specific reason (e.g., shared Redis namespace but per-project history files).

### Environment Variables

```bash
# Point to a shared Redis instance
export AGENTSYNCLAYER_REDIS_URL=redis://redis-server:6379

# Share a bus namespace across monorepo packages
export AGENTSYNCLAYER_BUS_DIR=/home/dev/monorepo

# Store history DB in a dedicated location
export AGENTSYNCLAYER_DB_DIR=/home/dev/.cache/agentsynclayer
```

### Config File (.agentsynclayer.json)

Create a `.agentsynclayer.json` file in your project directory:

```json
{
  "redis": "redis://redis-server:6379",
  "bus": "/shared/workspace",
  "db": "/shared/data"
}
```

### Precedence

Each option is resolved independently (per-field precedence):
- Environment variable > config file > default

For example, you can set `AGENTSYNCLAYER_REDIS_URL` via environment variable while using the config file for `bus` and `db`.

### Project Isolation

AgentSyncLayer automatically isolates traffic by project. Each project gets a unique namespace derived from its canonical path:

```
/home/dev/projects/myapp → a1b2c3d4e5f6
```

This means:
- Agents on `/home/dev/projects/myapp` cannot see agents on `/home/dev/projects/other-app`
- No configuration required—isolation is automatic for single-project setups
- Symlinks to the same directory share the same namespace

### Shared Bus Configuration

For monorepos and multi-project setups, you can share a bus namespace across different directories using a `.agentsynclayer.json` config file. Place the config file in **each directory that needs the shared bus**.

```json
{
  "bus": "/path/to/shared/root",
  "db": "/path/to/shared/data",
  "redis": "redis://shared-redis:6379"
}
```

**How it works:**
1. AgentSyncLayer looks for `.agentsynclayer.json` in the current working directory only (no ancestor walk)
2. The config file's `bus` directory determines the project hash
3. All agents pointing to the same `bus` directory share the same Redis namespace and SQLite database
4. For monorepos, place `.agentsynclayer.json` in **each** package that needs the shared bus

**Example: Monorepo**

Place `.agentsynclayer.json` in each package that needs the shared bus:

```json
// /mono/packages/api/.agentsynclayer.json
{ "bus": "../.." }

// /mono/packages/web/.agentsynclayer.json
{ "bus": "../.." }
```

Now agents in `/mono/packages/api` and `/mono/packages/web` share the same bus, see each other's messages, and use the same SQLite history database.

**Configuration precedence:**
Each field is resolved independently:
- `AGENTSYNCLAYER_REDIS_URL` > `redis` key > default
- `AGENTSYNCLAYER_BUS_DIR` > `bus` key > default
- `AGENTSYNCLAYER_DB_DIR` > `db` key > default

---

## Usage Examples

Plain-English prompts you can give to your agent. The agent will call the appropriate bus tools automatically.

### Check if the bus is working

> "Can you see the ASL bus?"

### Send a message

> "Send a message to the ASL bus saying I'm starting work on the auth module"
> "Post an error to the bus: Redis connection keeps dropping"
> "Let the other agents know I've finished the API refactor"

### Check what's happening

> "What messages are on the general channel?"
> "Check #docs for any new messages"
> "Are there any errors on the bus?"
> "Search the bus history for mentions of rate limiting"

### See who's around

> "Who else is working on this project?"
> "What are the other agents doing?"
> "Show me all active agents and their current tasks"

### Coordinate file edits

> "Claim src/auth/login.ts before I start editing it"
> "Check if anyone has claimed the config file"
> "Release my claim on src/auth/login.ts, I'm done"
> "Who has src/api/routes.ts claimed?"

### Announce your status

> "Update my status to: implementing JWT authentication, working on login.ts and session.ts"
> "Let the bus know I'm switching to work on the frontend"

### Wait for updates

> "Listen on the general channel for 30 seconds"
> "Watch for any new messages on claims or general"

---

## Usage Guide

### Publishing Messages

Send a status update to the `general` channel:

```
bus_send(channel="general", message="Starting auth module refactor", type="status")
```

Response:
```json
{
  "ok": true,
  "data": {
    "id": "msg-550e8400-e29b-41d4-a716-446655440000",
    "channel": "general",
    "timestamp": "2026-04-06T14:30:00.000Z"
  }
}
```

**Message types:**
- `info` — General information (default)
- `status` — Status updates
- `error` — Error reports or blockers
- `coordination` — Coordination requests
- `claim` — Auto-published on file claims
- `release` — Auto-published on file releases

### Reading Messages

Read the last 20 messages from `general`:

```
bus_read(channel="general", limit=20)
```

Response:
```json
{
  "ok": true,
  "data": {
    "channel": "general",
    "messages": [
      {
        "id": "msg-...",
        "from": "devbox-48201-a7f2",
        "type": "status",
        "payload": { "text": "Starting auth module refactor" },
        "timestamp": "2026-04-06T14:30:00.000Z"
      }
    ],
    "count": 1,
    "total": 47
  }
}
```

### Updating Your Status

Announce what you're working on:

```
bus_status(task="Refactoring login flow to use JWT", files=["src/auth/login.ts", "src/auth/session.ts"], channels=["general", "auth"])
```

Response:
```json
{
  "ok": true,
  "data": {
    "agentId": "devbox-48201-a7f2",
    "task": "Refactoring login flow to use JWT",
    "files": ["src/auth/login.ts", "src/auth/session.ts"],
    "expiresAt": "2026-04-06T14:31:30.000Z"
  }
}
```

### Listing Active Agents

See who's working on the project:

```
bus_agents()
```

Response:
```json
{
  "ok": true,
  "data": {
    "agents": [
      {
        "id": "devbox-48201-a7f2",
        "task": "Refactoring login flow",
        "files": ["src/auth/login.ts", "src/auth/session.ts"],
        "claimedFiles": ["src/auth/login.ts"],
        "channels": ["general", "auth"],
        "lastHeartbeat": "2026-04-06T14:05:30.000Z"
      },
      {
        "id": "devbox-49102-b3c4",
        "task": "Adding rate limiting to API",
        "files": ["src/api/rate-limit.ts"],
        "claimedFiles": [],
        "channels": ["general"],
        "lastHeartbeat": "2026-04-06T14:05:25.000Z"
      }
    ],
    "count": 2
  }
}
```

### Claiming a File

Before editing `src/auth/login.ts`, claim it:

```
bus_claim(path="src/auth/login.ts")
```

**Success (claim acquired):**
```json
{
  "ok": true,
  "data": {
    "path": "src/auth/login.ts",
    "agentId": "devbox-48201-a7f2",
    "claimedAt": "2026-04-06T14:01:00.000Z",
    "expiresAt": "2026-04-06T14:06:00.000Z"
  }
}
```

**Conflict (already claimed):**
```json
{
  "ok": false,
  "error": "File 'src/auth/login.ts' is already claimed by agent devbox-49102-b3c4 (claimed at 2026-04-06T14:00:00.000Z, expires at 2026-04-06T14:05:00.000Z)",
  "code": "CLAIM_CONFLICT",
  "data": {
    "path": "src/auth/login.ts",
    "heldBy": "devbox-49102-b3c4",
    "claimedAt": "2026-04-06T14:00:00.000Z",
    "expiresAt": "2026-04-06T14:05:00.000Z"
  }
}
```

### Releasing a Claim

When done editing, release the claim:

```
bus_release(path="src/auth/login.ts")
```

Response:
```json
{
  "ok": true,
  "data": {
    "path": "src/auth/login.ts",
    "released": true
  }
}
```

### Listening for Messages

Wait for new messages on channels:

```
bus_listen(channels=["general", "claims"], timeout=10)
```

Response (new message arrived):
```json
{
  "ok": true,
  "data": {
    "messages": [
      {
        "id": "msg-...",
        "from": "devbox-49102-b3c4",
        "channel": "general",
        "type": "status",
        "payload": { "text": "Finished API rate limiter, running tests" },
        "timestamp": "2026-04-06T14:35:00.000Z"
      }
    ],
    "count": 1,
    "polled": true,
    "timeout": false
  }
}
```

Response (timeout, no new messages):
```json
{
  "ok": true,
  "data": {
    "messages": [],
    "count": 0,
    "polled": true,
    "timeout": true
  }
}
```

### Listing Channels

See all active channels in the project:

```
bus_channels()
```

Response:
```json
{
  "ok": true,
  "data": {
    "channels": [
      { "name": "general", "messages": 47 },
      { "name": "errors", "messages": 3 },
      { "name": "auth", "messages": 12 },
      { "name": "claims", "messages": 8 }
    ],
    "count": 4
  }
}
```

---

## API Reference

### Response Format

All tools return JSON with a consistent envelope:

**Success:**
```json
{
  "ok": true,
  "data": { ... }
}
```

**Error:**
```json
{
  "ok": false,
  "error": "Human-readable description",
  "code": "MACHINE_READABLE_CODE"
}
```

### Error Codes

| Code | Meaning | Recovery |
|------|---------|----------|
| `BUS_UNAVAILABLE` | Both Redis and SQLite are unavailable | Wait and retry; check Redis is running |
| `CHANNEL_INVALID` | Channel name fails validation | Fix channel name (1-64 alphanumeric/hyphen/underscore) |
| `INVALID_CONTEXT` | Tool called without required context | Ensure directory context is provided |
| `CLAIM_CONFLICT` | File already claimed | Wait for expiry, negotiate, or proceed anyway |
| `CLAIM_NOT_FOUND` | No claim exists | No action needed |
| `CLAIM_NOT_OWNER` | Attempting to release a claim you don't own | Check agent status |
| `PATH_INVALID` | File path fails validation | Fix path (relative, no `..`, no leading `/`) |
| `QUERY_INVALID` | Search query is empty | Provide a non-empty search term |
| `RATE_LIMITED` | Too many messages per second | Wait before sending more |
| `INTERNAL_ERROR` | Unexpected error | Check logs; may indicate Redis/SQLite issue |
| `SQLITE_UNAVAILABLE` | SQLite history/search not available | Continue without history; bus_send/read still work via Redis |
| `MESSAGE_EMPTY` | Message text is empty | Provide non-empty message |
| `MESSAGE_TOO_LONG` | Message exceeds 4096 characters | Shorten message |
| `TYPE_INVALID` | Invalid message type | Use one of: info, status, error, coordination, claim, release |
| `TIMEOUT_INVALID` | Invalid timeout value | Use integer between 1 and 30 seconds |
| `LIMIT_INVALID` | Invalid limit value | Use integer between 1 and 100 |
| `TASK_EMPTY` | Task description is empty | Provide non-empty task description |
| `TASK_TOO_LONG` | Task description exceeds 256 characters | Shorten task description |

### Tool Schemas

#### bus_send

```typescript
{
  channel: string,        // required, 1-64 alphanumeric/hyphen/underscore
  message: string,         // required, max 4096 characters
  type?: 'info' | 'status' | 'error' | 'coordination' | 'claim' | 'release'
}
```

#### bus_read

```typescript
{
  channel: string,         // required
  limit?: number           // optional, 1-100, default 20
}
```

#### bus_channels

```typescript
{}  // No arguments
```

#### bus_status

```typescript
{
  task: string,            // required, max 256 characters
  files?: string[],        // optional, default []
  channels?: string[]      // optional, default ["general"]
}
```

#### bus_agents

```typescript
{}  // No arguments
```

#### bus_info

```typescript
{}  // No arguments
```

Returns the resolved bus configuration including project hash, bus directory, database directory, and config source.

#### bus_claim

```typescript
{
  path: string             // required, relative path (e.g., "src/auth/login.ts")
}
```

#### bus_release

```typescript
{
  path: string             // required, relative path
}
```

#### bus_listen

```typescript
{
  channels?: string[],     // optional, default ["general"]
  timeout?: number         // optional, 1-30 seconds, default 10
}
```

#### bus_history

```typescript
{
  channel?: string,        // optional, omit for all channels
  page?: number,           // optional, 1-indexed, default 1
  per_page?: number         // optional, 1-100, default 50
}
```

#### bus_search

```typescript
{
  query: string,           // required, search query text
  channel?: string,        // optional, omit for all channels
  limit?: number           // optional, 1-100, default 20
}
```

---

## Architecture

### Design Principles

1. **Project isolation by default** — Namespace derived from path hash; no cross-project leakage
2. **Advisory coordination** — Claims are hints, not enforced locks; agents cooperate voluntarily
3. **Graceful degradation** — Redis/SQLite unavailability doesn't crash agents; they continue in degraded mode
4. **Memory bounds** — Redis data is capped (100 messages/channel, TTLs on status/claims); SQLite holds full history
5. **Dual-write durability** — Messages written to both Redis (fast cache) and SQLite (durable storage)

### Redis Key Schema

All keys use the prefix `opencode:{project_hash}`:

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `opencode:{hash}:ch:{channel}` | Pub/Sub | N/A | Real-time message delivery |
| `opencode:{hash}:history:{channel}` | Sorted Set | None (capped at 100) | Recent message cache |
| `opencode:{hash}:channels` | Set | None | Active channel registry |
| `opencode:{hash}:agent:{agentId}` | String | 90s | Agent status with heartbeat |
| `opencode:{hash}:claim:{filePath}` | String | 300s | Advisory file claims |
| `opencode:{hash}:lastseen:{agentId}` | String | 24h | Last-read timestamp for notifications |

### SQLite Schema

SQLite provides durable message persistence in `.agentsynclayer/history.db`:

| Table | Purpose |
|-------|---------|
| `messages` | Full message history with timestamps |
| `messages_fts` | FTS5 virtual table for full-text search |
| `channels` | Channel registry with message counts |

**Features:**
- WAL mode for concurrent reads during writes
- FTS5 triggers auto-index message content for search
- Indexes on `(channel, created_at)` and `(project, channel, created_at)`
- Graceful degradation when SQLite unavailable

### Agent Identification

Each agent gets a unique ID generated at session start:

```
{hostname}-{pid}-{random4hex}
```

Example: `devbox-48201-a7f2`

This ID is:
- Unique per OpenCode process (PID differs per instance)
- Stable for the session lifetime
- Human-readable for debugging

### Heartbeat Protocol

Agents maintain presence via heartbeat:
- **Interval**: 30 seconds
- **TTL**: 90 seconds
- Agents without a heartbeat for >90s are considered stale and excluded from `bus_agents`

### File Claim Protocol

1. Agent calls `bus_claim` with file path
2. Redis SET with NX (only if not exists) and EX 300 (5-minute TTL)
3. Lua script handles race conditions atomically
4. Claim event auto-published to `claims` channel
5. Claims auto-expire after 5 minutes if not released

### Rate Limiting

- 10 messages per second per agent (sliding window)
- Applied client-side via `RateLimiter` class
- Prevents accidental Redis spam

### Session Compaction

When OpenCode compacts a session, AgentSyncLayer injects coordination context:

```markdown
## AgentSyncLayer — Active Coordination State

### Active Agents (2)
- **devbox-48201-a7f2**: Refactoring login flow
  Files: src/auth/login.ts, src/auth/session.ts

### Recent Messages
- [general] devbox-49102-b3c4: Finished API rate limiter

### Your File Claims
- src/auth/login.ts (expires 2026-04-06T14:06:00.000Z)
```

### Unread Message Notifications

The `experimental.chat.system.transform` hook proactively notifies agents of unread messages:

- Retrieves last-seen timestamp from Redis (`opencode:{hash}:lastseen:{agentId}`)
- Queries SQLite for messages newer than the timestamp
- Groups by channel and injects compact notification into system prompt

```
[AgentSyncLayer] Unread messages:
- general: 3 message(s) from devbox-49102-b3c4, devbox-48201-a7f2 — latest: "Finished the refactor"
- claims: 1 message(s) from devbox-49102-b3c4 — latest: "Claimed src/auth/login.ts"
Use bus_read to view details.
```

### Cleanup on Session End

When `session.idle` or `session.deleted` fires:
1. Stop heartbeat timer
2. Delete agent status key
3. Release all held claims
4. Clean up rate limiter state
5. Close SQLite connection

---

## Troubleshooting

### "Bus unavailable: Redis connection not established"

**Cause**: Redis is not running or not accessible.

**Fix**:
```bash
# Check if Redis is running
redis-cli ping

# If not, start it
brew services start redis   # macOS
sudo systemctl start redis-server   # Linux

# Or start a container
docker run -d -p 6379:6379 redis:latest
```

### "Invalid channel name"

**Cause**: Channel name contains invalid characters.

**Fix**: Use only alphanumeric characters, hyphens, and underscores (1-64 characters).

```bash
# Invalid: my channel (has space)
# Valid: my-channel

bus_send(channel="my-channel", message="Hello")
```

### "File is already claimed"

**Cause**: Another agent holds an advisory claim on the file.

**Fix**:
1. Check who holds the claim via the error response
2. Wait for the claim to expire (5 minutes)
3. Negotiate with the other agent
4. Proceed anyway if you accept the risk

### "Rate limit exceeded"

**Cause**: Sending more than 10 messages per second.

**Fix**: Wait a moment before sending more messages, or batch messages.

### Agent not appearing in `bus_agents`

**Cause**: Heartbeat hasn't started or Redis connection is down.

**Fix**:
1. Verify Redis is running
2. Check agent status via `bus_status` tool
3. Ensure the project path hasn't changed

### Messages not appearing for other agents

**Cause**: Different project namespaces.

**Fix**: Both agents must be running in the same project directory (or symlinked directories that resolve to the same canonical path). In monorepos, ensure each package has its own `.agentsynclayer.json` pointing to the shared bus root.

### Verifying bus configuration

**Use `bus_info`** to see which bus namespace your agent is connected to:

```
bus_info()
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "projectHash": "a1b2c3d4e5f6",
    "bus_dir": "/home/user/monorepo",
    "db_dir": "/home/user/monorepo",
    "source": "config",
    "configPath": "/home/user/monorepo/.agentsynclayer.json"
  }
}
```

The `source` field shows how the bus was resolved:
- `env` — From `AGENTSYNCLAYER_BUS_DIR` environment variable
- `config` — From `.agentsynclayer.json` file
- `default` — From current working directory

---

## Development

### Project Structure

```
agentsynclayer/
├── src/
│   ├── index.ts           # Plugin entry point
│   ├── agent.ts           # Agent ID generation
│   ├── heartbeat.ts       # Agent presence heartbeat
│   ├── namespace.ts       # Project hash & key building
│   ├── rate-limiter.ts    # Message rate limiting
│   ├── redis.ts           # Redis client wrapper
│   ├── session.ts         # Session agent ID management
│   ├── sqlite.ts          # SQLite client with FTS5
│   ├── types.ts           # TypeScript type definitions
│   ├── validation.ts      # Input validation
│   ├── adapter.ts         # OpenCode plugin adapter
│   ├── lifecycle.ts       # Shared helpers for hooks
│   ├── config.ts          # Bus config resolution (.agentsynclayer.json, env vars)
│   └── tools/
│       ├── index.ts       # Tool exports
│       ├── bus_send.ts    # Publish message (dual-write)
│       ├── bus_read.ts    # Read messages (SQLite fallback)
│       ├── bus_channels.ts # List channels
│       ├── bus_status.ts  # Update status
│       ├── bus_agents.ts  # List agents
│       ├── bus_info.ts    # Bus configuration info
│       ├── bus_claim.ts   # Claim file
│       ├── bus_release.ts  # Release claim
│       ├── bus_listen.ts  # Long-poll messages
│       ├── bus_history.ts # Paginated history (SQLite)
│       ├── bus_search.ts  # Full-text search (FTS5)
│       └── notifications.ts # Last-seen timestamp tracking
└── test/
    ├── helpers.ts
    ├── fixtures.ts
    ├── unit/
    │   ├── agent.test.ts
    │   ├── heartbeat.test.ts
    │   ├── namespace.test.ts
    │   ├── rate-limiter.test.ts
    │   ├── validation.test.ts
    │   ├── sqlite.test.ts
    │   ├── bus_history.test.ts
    │   ├── bus_search.test.ts
    │   ├── notifications.test.ts
    │   └── system-transform.test.ts
    └── integration/
        ├── sqlite-dual-write.test.ts
        ├── sqlite-fallback.test.ts
        ├── sqlite-notifications.test.ts
        └── sqlite-degradation.test.ts
```

### Running Tests

```bash
# Run all tests
bun test

# Run unit tests only
bun run test:unit

# Run integration tests only (requires Redis)
bun run test:integration

# Type check
bun run typecheck
```

### Building

AgentSyncLayer is written in TypeScript and uses Bun's built-in TypeScript support. No build step required—the source is served directly.

### Adding New Tools

1. Create `src/tools/bus_<name>.ts` with `bus<Name>Execute` function
2. Export the function from `src/tools/index.ts`
3. Add tool definition to `tools` array in `src/index.ts`
4. Add tests in `test/unit/`

---

## License

MIT


