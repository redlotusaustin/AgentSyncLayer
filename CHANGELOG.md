# Changelog

All notable changes to AgentSyncLayer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.6] - 2026-04-18

### Security
- Guard `bun:sqlite` import with dynamic loading — plugin no longer crashes outside Bun runtime (H1)
- Validate `bus_status` args.files/args.channels before Redis storage — prevents prompt injection via compaction hook (H4)
- Add try-catch to all three OpenCode hooks (compaction, system transform, event) — prevents Redis/SQLite errors from propagating (H5)

### Bug Fixes
- Fix Redis `subscribe()` listener leak — added unsubscribe handler cleanup (H2)
- Fix corrupted SQLite client staying in singleton map forever — evict and re-attempt on write failure (H3)
- Fix `rowToMessage()` JSON.parse crash on corrupted payload data (M9)
- Fix `bus_agents` returning wrong error code for invalid context (M5)
- Fix `bus_release` using non-standard error message for invalid context (M6)
- Fix config file permission errors silently swallowed (M8)
- Fix `parseInt` NaN fallback in notifications timestamp (L3)
- Fix `validateFilePath` returning empty string instead of throwing for non-string input (L1)

### Improvements
- Standardize Redis/context check ordering across all 11 tools — context first (M7)
- Add agent ID validation in rate limiter (M10)
- Derive `validateMessageType` valid types from `MessageType` union instead of hardcoded array (L2)
- Add `bus_info` to BUS_INSTRUCTIONS in system prompt (L5)
- Document rate limiter and Redis client limitations (L7, L8)

### Documentation
- Update README version from 0.6.0 to 0.8.6 (M1)
- Remove broken doc links (M2)
- Add consumer-facing install instructions (M3)
- Fix `session.end` → `session.deleted` in README (M4)
- Update error codes table to include all 18 codes (L6)

### Cleanup
- Delete stale `opencode-asl-0.6.3.tgz` from repo (M11)
- Delete stale `package/` directory from v0.6.0 (M12)
- Add `*.tgz` and `package/` to `.gitignore` (M11)
- Update package description to reflect Redis + SQLite (M13)
- Remove dead code: `_filter`, `_magenta`, `buildKey`, `KeyBuilder`, `createKeyBuilder`, `ValidationError`, `ClaimConflictError` (L4)

## [0.8.5] - 2026-04-18

### Fixed
- **Critical**: Added `./server` subpath export to package.json — OpenCode imports plugins via `packageName/server`, not `packageName`. Missing export caused silent import failure, returning `undefined`, which crashed OpenCode accessing `.config`

## [0.8.4] - 2026-04-18

### Fixed
- Wrapped plugin initialization in try-catch to guarantee a valid `Hooks` object is always returned, even if Redis connection or heartbeat startup fails
- Added missing close brace for event handler in return object (syntax error from prior edit)

## [0.8.3] - 2026-04-17

### Fixed
- Added required `config` hook (no-op) to plugin return — OpenCode's plugin interface requires `config` in the `Hooks` object

## [0.8.2] - 2026-04-17

### Fixed
- Added `INVALID_CONTEXT` guard to `bus_release.ts` and `bus_agents.ts` — OpenCode calls tool execute functions during plugin initialization before session context is available

## [0.8.1] - 2026-04-17

### Fixed
- Moved `@opencode-ai/plugin` from `devDependencies` to `dependencies` — NPM doesn't install dev/peer deps for consumers, causing runtime import failure

## [0.8.0] - 2026-04-17

### Fixed
- **Critical**: Eliminated zod version conflict that caused NPM plugin loading crash
  - Removed standalone `zod` dependency — now imports via `@opencode-ai/plugin`'s `tool.schema`
  - Ensures single zod instance, fixing the `_zod.def` crash when loaded via NPM
- Replaced zod schema validation in config.ts with manual validation (removes runtime zod usage)
- Suppressed noisy ENOENT debug log on startup when `.agentsynclayer.json` does not exist
- Added `console.warn` in `toAslContext()` guard for better debuggability on malformed context

### Changed
- Replaced local `defineTool()` helper with SDK's `tool()` function (removed unnecessary abstraction)
- Removed `zod` from package.json dependencies (-1 dep)

## [0.6.0] - 2026-04-17

### Changed
- **Breaking**: Replaced ancestor walk config discovery with local-config-only resolution
- Config file `.agentsynclayer.json` is now searched only in current working directory (no ancestor walk)
- For monorepo support, each package must have its own `.agentsynclayer.json` pointing to the shared bus root
- Simplified config resolution logic, removed redundant variables

### Fixed
- Zod v4 error handling in parseConfig (different error shape)
- README inconsistencies for local-config-only behavior

### Added
- New tests for local-config-only discovery (T3.8-T3.17)
- Integration tests for monorepo cross-directory communication (I1.1-I1.4)
- Config error handling tests (T5.1-T5.5)

## [0.5.2] - 2026-04-09

### Changed
- npm publishing readiness: explicit `private: false`, updated README version, added CHANGELOG

## [0.5.1] - 2026-04-09

### Fixed
- Pre-distribution fixes across 5 stages (full audit, bug hunt, code review)
- Corrected FTS5 hidden column assertion in schema test
- Addressed 4 bugs from adversarial bug hunt (atomic Lua claims, session agent ID, rate limiter cleanup, BRPOP)
- Addressed 7 code review findings (error handling, validation, TypeScript strictness)
- Full audit deviations resolved (missing error codes, README inconsistencies)

### Refactored
- Simplified and cleaned up code across 8 source files
- Removed dead code across 7 source files
- Deduplicated logic and improved code quality
- Batched Redis operations and switched to blocking listen for performance

### Added
- Biome for linting and formatting

## [0.5.0] - 2026-04-06

### Added
- SQLite-backed message persistence with FTS5 full-text search
- `bus_history` tool for paginated deep history queries
- `bus_search` tool for full-text search across message history
- `bus_info` tool for resolved bus configuration inspection
- `bus_listen` tool for long-poll message waiting
- Session compaction hook for coordination context injection
- Unread message notifications via system transform hook
- `bus-monitor.ts` CLI for inspecting and tailing bus state (snapshot, watch, follow modes)
- Dual-write durability (Redis cache + SQLite persistent storage)
- WAL mode SQLite for concurrent read/write performance

### Changed
- Redis history sorted sets now serve as fast cache (capped at 100 messages)
- SQLite is the source of truth for full message history
- Renamed AgentBus to AgentSyncLayer throughout

## [0.3.0] - 2026-03-20

### Added
- Shared bus identity configuration via `.agentsynclayer.json` config file
- `AGENTSYNCLAYER_BUS_ID` environment variable for bus override
- `bus_info` diagnostic tool for resolved bus configuration
- Configuration precedence: env var > config file > default directory
- Monorepo support via shared bus namespace

### Fixed
- Config ancestor walk error visibility and warning logic
- 7 code review issues from initial review pass

### Performance
- Reduced syscalls and eliminated redundant computations in config resolution

## [0.2.0] - 2026-03-18

### Added
- SQLite persistence layer for durable message history
- External CLI bus monitor script with watch and follow modes
- Bus usage instructions injected into system prompt

### Fixed
- Guard against undefined `args.task` in `bus_status`
- Shared session agent ID between plugin and tools
- Atomic file claims via Redis Lua script
- Configurable SCAN count for Redis key enumeration

### Changed
- Bumped version to 0.2.0

## [0.1.0] - 2026-03-15

### Added
- Initial release with Redis-backed pub/sub messaging
- `bus_send`, `bus_read`, `bus_channels` tools
- `bus_status`, `bus_agents` tools for agent coordination
- `bus_claim`, `bus_release` tools for advisory file locking
- Project isolation via path-derived namespace hashing
- Agent heartbeat protocol (30s interval, 90s TTL)
- Rate limiting (10 messages/second per agent)
- Graceful degradation when Redis is unavailable
- OpenCode plugin adapter with Zod schema validation
- Test helpers, fixtures, and integration tests
