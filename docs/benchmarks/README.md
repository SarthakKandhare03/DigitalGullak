# Benchmarks

`npm run bench` seeds 25 users (with example data) into a fresh database, starts the production server in a separate process and drives each endpoint for 8 seconds with 50 concurrent connections (autocannon). Every request sends `Accept-Encoding: br, gzip`, as browsers do. The write test creates a new simulated deposit, with a unique idempotency key, on every request; each one is also settled by the mock partner and delivered as a signed webhook.

## Before vs after (same machine, same time window)

"Before" is commit `b1d2220`; "after" is the scaling and security work. Both copies ran outside OneDrive, and the runs were interleaved (before → after → before → after) so background load affected both equally. The machine was a shared 12-core Windows laptop with other applications running, so absolute numbers are modest; the ratios are what matter.

| Requests/s | Before (avg of 2) | After, 1 worker (avg of 2) | After, 4 workers |
|---|---:|---:|---:|
| `GET /api/dashboard` | 386 | 519 (**1.3×**) | 1,046 (**2.7×**) |
| `GET /api/rewards` | 416 | 527 (**1.3×**) | 1,189 (**2.9×**) |
| `GET /api/activity` | 546 | 605 (**1.1×**) | 1,121 (**2.1×**) |
| `POST` deposit (write) | 54 | 155 (**2.9×**) | 117 (2.2×) |
| Write latency p50 | 700 ms | 328 ms | 160 ms |
| Write latency p99 | 1,701 ms | 555 ms | 1,826 ms ⚠️ |

Raw results: `before-run*.json`, `after-1-worker-run*.json`, `after-4-workers.json`.

On a quiet machine, earlier the same day, the single-worker build reached about 1,250 dashboard and 270 write requests/s, and 4 workers about 2,950 dashboard requests/s.

## What made the difference

| Change | Effect |
|---|---|
| SQLite `synchronous=NORMAL` in WAL mode, a 32 MB page cache, 256 MB memory-mapped reads, in-memory temp storage | Commits no longer wait for a disk flush; this is the main reason writes are about 3× faster. Set `DB_SYNCHRONOUS=full` when real money is involved: it measured 91 writes/s here. |
| gzip level 6 applied synchronously to API JSON, replacing stream-based Brotli | For these 2–10 KB payloads it is about 3.5× cheaper per response (35 µs vs 120 µs) at almost the same size, and it avoids allocating a Brotli stream per response. |
| Static assets pre-compressed at build time (Brotli q11 + gzip 9), with immutable caching | No compression CPU for assets at all; 466 KB of text shrinks to 132 KB. |
| `goal_balances` cache maintained by a trigger | Balance reads no longer sum the whole ledger, so their cost stays flat as history grows. A background check proves the cache equals the ledger. |
| Rewards summary is read-only unless something new was earned | Previously every `GET /api/rewards` took SQLite's write lock. |
| One log line per request, logged by route pattern | Half the log volume, with no IDs or query strings in the logs. |
| Cluster mode (`WEB_CONCURRENCY`) | Spreads reads across cores, at about 2–3× with 4 workers. |

## Limits, honestly

- **Writes don't scale with more workers.** SQLite has a single writer, and `node:sqlite` waits for the lock synchronously, which also stalls that worker's reads while it waits. With 4 workers under a write-heavy load, write throughput dropped below one worker's and p99 latency reached about 1.8 s. Use `WEB_CONCURRENCY=2–4` for read-heavy traffic and 1 for write-heavy traffic. Going beyond a few hundred writes per second needs PostgreSQL: the SQL lives in a thin repository layer and the schema is portable.
- `WEB_CONCURRENCY=auto` is capped at 4 because 8 workers measured slower than 4.
- The write benchmark includes the mock partner's own work (settling transfers and delivering webhooks into the same database). With a real partner that work happens on their systems, so these write numbers are pessimistic.

## Re-running

```bash
npm run bench                                # 1 worker
WEB_CONCURRENCY=4 npm run bench              # cluster
BENCH_ONLY=dashboard,write npm run bench     # a subset
DB_SYNCHRONOUS=full npm run bench            # fsync every commit
npm run bench -- --out docs/benchmarks/my-run.json
```
