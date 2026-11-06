# Configuration

The server reads every setting from environment variables, once, at startup. `packages/server/src/config.ts` parses them with zod, and no other code reads `process.env`. If a setting is missing or malformed, the server exits before listening and lists each one with what's wrong.

In development, `pnpm dev` loads `.env.example`, then `.env` if it exists, so your own `.env` overrides the synthetic defaults. git ignores `.env`. Leave `PORT` at 3000 in development: Vite forwards API requests there.

| Variable | Required | Format | What it's for |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgres://` URL | The owner role's connection |
| `AIRWAY_READER_DATABASE_URL` | yes | `postgres://` URL | The read-only reader role's connection |
| `AIRWAY_PATIENT_NAME` | yes | 1 to 80 characters | Shown in the app's header and the MCP instructions |
| `AIRWAY_PATIENT_BIRTH_DATE` | yes | `YYYY-MM-DD` | Picks the scoring rules ([Scoring](scoring.md)) |
| `AIRWAY_ADULT_RULES_FROM_13` | no, `false` | `true` or `false` | Scores ages 13 to 17 with adult rules |
| `AIRWAY_CLOCK_OFFSETS` | yes | JSON array | The CPAP clock's UTC offsets, described below |
| `AIRWAY_TIME_ZONE` | yes | IANA zone, such as `America/Chicago`; not a fixed offset such as `-05:00` | The home time zone: night boundaries, alert times, and every time the app shows |
| `AIRWAY_CPAP_DATA_PATH` | yes | absolute path | The folder holding a read-only copy of the CPAP's SD card |
| `PORT` | no, `3000` | 1 to 65535 | The HTTP port |
| `LOG_LEVEL` | no, `info` | `fatal`, `error`, `warn`, `info`, `debug`, or `trace` | The lowest level logged |

## Clock offsets

The CPAP's clock doesn't follow daylight saving time, and it drifts. `AIRWAY_CLOCK_OFFSETS` lists the offset that converts its timestamps to UTC, and the night each offset starts on:

```json
[
  { "from": "2025-01-01", "utcOffset": "-05:07" },
  { "from": "2026-03-01", "utcOffset": "-05:00" }
]
```

Each entry applies from its night until the next entry's night. Entries are sorted by `from`, with no night listed twice. `utcOffset` is `±HH:MM`.
