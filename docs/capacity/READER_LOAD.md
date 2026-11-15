# Reader load qualification (AB-102, partial)

`tools/perf/load.mjs` drives concurrent GET requests against public reading routes only (`/bills…`, `/learn…`, `/privacy`, `/accessibility`, `/about`, `/health/live|ready`). It never posts questions, opens generations or sends cookies, so it cannot incur AI or voice spend. Remote targets need `--allow-remote`; requests are capped at 20,000 and concurrency at 200. Exit code 2 means the latency or error budget failed.

```sh
corepack pnpm dev &   # synthetic local demo
node tools/perf/load.mjs --target http://127.0.0.1:4100 --paths /bills,/learn,/about,/privacy --concurrency 25 --requests 1000 --p95-ms 500
```

## Measured baseline (local synthetic demo, not hosted)

2026-11-15, Node 24.19.0, single process, development sandbox: 1,000 requests at concurrency 25 → ~2,040 req/s, p50 9 ms, p95 19.7 ms, p99 47.9 ms, 0 errors. This measures the application code path only; it excludes network, TLS, PostgreSQL latency and free-plan CPU limits.

## Not yet measured
- Hosted staging (Render free plan + Neon free compute): cold start after idle spin-down, database round-trips, 512 MB memory ceiling. Run with `--allow-remote` against the staging origin from a network that can reach it.
- 1,000-reader / 25-generation scenario, answer latency, spend ceilings and graceful degradation with live providers (needs provider keys and an approved spend cap).
- Browser web vitals, frame times and memory for the character stage.
