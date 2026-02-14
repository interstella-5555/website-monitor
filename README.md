# website-monitor

Generic website monitoring engine with ntfy push notifications. Runs checks every minute, detects state changes, and sends alerts.

## Monitors

| Monitor | What it checks | States |
|---|---|---|
| **bookero** | USG appointment availability on Bookero | `available` / `unavailable` |
| **sportivo** | S-Sportivo membership registration status | `open` / `closed` |

## Setup

```bash
bun install
```

Copy `.env.example` and configure:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `NTFY_TOPIC` | yes | — | ntfy.sh topic for push notifications |
| `DB_PATH` | no | `/data/monitor.db` | SQLite database path |
| `MONITOR_BOOKERO` | no | `true` | Enable/disable bookero monitor |
| `MONITOR_SPORTIVO` | no | `true` | Enable/disable sportivo monitor |
| `NTFY_DEBUG_TOPIC` | no | — | Separate ntfy topic for every-cycle status notifications |

## Run

```bash
bun run src/index.ts
```

## How it works

- Checks all enabled monitors every minute
- On first run: sends initial state notification
- On state change: sends alert notification
- On errors: sends notification after 15 minutes of consecutive failures, then recovery notification when the monitor comes back

## Adding a new monitor

1. Create `src/monitors/<name>.ts` implementing the `Monitor` interface
2. Add it to the `all` array in `src/monitors/index.ts`

The monitor is enabled by default. Set `MONITOR_<NAME>=false` to disable.

## Docker

```bash
docker build -t website-monitor .
docker run -e NTFY_TOPIC=your-topic -v monitor-data:/data website-monitor
```
