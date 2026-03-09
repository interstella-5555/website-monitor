# Ghibli Park Ticket Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Monitor l-tike.com for when May O-Sanpo Day Pass Premium tickets go on sale at Ghibli Park.

**Architecture:** New Playwright Firefox-based monitor with self-throttling. The site's HTTP/2 is broken (Chromium and `fetch()` fail with `ERR_HTTP2_PROTOCOL_ERROR`), so we use Firefox. The site shows a Terms of Use gate that must be accepted before ticket listings are visible. The monitor caches results and throttles checks based on JST time of day — every 5 minutes before 13:00 JST, every 1 minute after (sale expected at 14:00 JST).

**Tech Stack:** Playwright (Firefox), Bun, existing monitor engine (cron + SQLite + ntfy)

---

## Context

- **URL:** https://l-tike.com/st1/ghibli-pk-en4/sitetop
- **Target ticket:** `【Ｍａｙ】Ｇｈｉｂｌｉ　Ｐａｒｋ　Ｏ－Ｓａｎｐｏ　Ｄａｙ　Ｐａｓｓ　Ｐｒｅｍｉｕｍ`
- **Status values:** "Not Yet On Sale", "On Sale", "Sold Out"
- **Expected sale time:** 2026/3/10 14:00 JST

### Key challenges (discovered during testing)
1. Site's HTTP/2 is broken — Chromium and `fetch()` fail with `ERR_HTTP2_PROTOCOL_ERROR`. **Firefox works.**
2. Site shows Terms of Use gate — must check `#CONSENT_CHK_BOX` checkbox and click `#NEXT` button before seeing tickets.
3. Ticket listings use full-width text in a table at the bottom of the page.

---

### Task 1: Add Playwright dependency

**Files:**
- Modify: `package.json`

**Step 1: Install playwright**

```bash
bun add playwright
```

**Step 2: Install Firefox browser**

```bash
bunx playwright install firefox
```

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "Add playwright dependency"
```

---

### Task 2: Create the Ghibli monitor

**Files:**
- Create: `src/monitors/ghibli.ts`

**Step 1: Write the monitor module**

```typescript
import { firefox } from "playwright";
import type { Monitor, CheckResult } from "../index";

const GHIBLI_URL = "https://l-tike.com/st1/ghibli-pk-en4/sitetop";
const TARGET_TICKET = "【Ｍａｙ】Ｇｈｉｂｌｉ　Ｐａｒｋ　Ｏ－Ｓａｎｐｏ　Ｄａｙ　Ｐａｓｓ　Ｐｒｅｍｉｕｍ";

type GhibliState = "not_on_sale" | "on_sale" | "sold_out";

let lastRunAt = 0;
let lastResult: CheckResult | null = null;

function getJSTHour(): number {
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return jst.getHours();
}

function getThrottleInterval(): number {
  return getJSTHour() >= 13 ? 60 : 300;
}

function parseTicketState(pageText: string): GhibliState {
  const idx = pageText.indexOf(TARGET_TICKET);
  if (idx === -1) throw new Error("Target ticket not found on page");

  const afterTicket = pageText.slice(idx + TARGET_TICKET.length);
  const nextSection = afterTicket.indexOf("【");
  const section = nextSection !== -1 ? afterTicket.slice(0, nextSection) : afterTicket;

  if (section.includes("Not Yet On Sale")) return "not_on_sale";
  if (section.includes("On Sale")) return "on_sale";
  if (section.includes("Sold Out")) return "sold_out";

  throw new Error(`Unknown ticket status in section: ${section.slice(0, 200)}`);
}

const stateLabels: Record<GhibliState, string> = {
  not_on_sale: "Not Yet On Sale",
  on_sale: "On Sale",
  sold_out: "Sold Out",
};

async function fetchTicketState(): Promise<CheckResult> {
  const checkStart = performance.now();
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();

    const pageLoadStart = performance.now();
    const response = await page.goto(GHIBLI_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const pageLoadMs = Math.round(performance.now() - pageLoadStart);
    const httpStatus = response?.status() ?? 0;

    // Accept terms of use gate
    const checkbox = page.locator("#CONSENT_CHK_BOX");
    if (await checkbox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await checkbox.check();
      await page.locator("#NEXT").click();
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    }

    const pageText = await page.innerText("body");
    const state = parseTicketState(pageText);
    const totalMs = Math.round(performance.now() - checkStart);

    console.log(
      `[ghibli] Check done in ${totalMs}ms (page: ${pageLoadMs}ms, HTTP ${httpStatus}). State: ${state}`,
    );

    return {
      state,
      detail: stateLabels[state],
    };
  } finally {
    await browser.close();
  }
}

export const ghibliMonitor: Monitor = {
  name: "ghibli",
  url: GHIBLI_URL,

  async check(): Promise<CheckResult> {
    const now = Date.now();
    const interval = getThrottleInterval();
    const elapsed = (now - lastRunAt) / 1000;

    if (lastResult && elapsed < interval) {
      const remaining = Math.round(interval - elapsed);
      console.log(
        `[ghibli] Skipped (next check in ${remaining}s). Cached state: ${lastResult.state}`,
      );
      return lastResult;
    }

    const result = await fetchTicketState();
    lastRunAt = Date.now();
    lastResult = result;
    return result;
  },

  notification(result, previousState) {
    const state = result.state as GhibliState;

    if (state === "on_sale") {
      return {
        title: "Ghibli Park tickets ON SALE!",
        message:
          previousState === null
            ? `First check: May Premium tickets are on sale!`
            : `May Premium tickets just went on sale! Go go go!`,
        priority: 5,
        tags: ["tada"],
      };
    }

    if (state === "sold_out") {
      return {
        title: "Ghibli Park tickets sold out",
        message:
          previousState === null
            ? "First check: May Premium tickets are sold out."
            : "May Premium tickets are now sold out.",
        priority: 4,
        tags: ["warning"],
      };
    }

    return {
      title: "Ghibli Park tickets not yet on sale",
      message:
        previousState === null
          ? "First check: May Premium tickets are not yet on sale."
          : "May Premium tickets status changed to: not yet on sale.",
      priority: 3,
      tags: ["hourglass"],
    };
  },
};
```

**Step 2: Verify it compiles**

```bash
bun build src/monitors/ghibli.ts --no-bundle 2>&1 | head -5
```

Expected: No errors

**Step 3: Commit**

```bash
git add src/monitors/ghibli.ts
git commit -m "feat: add Ghibli Park ticket monitor"
```

---

### Task 3: Register the monitor

**Files:**
- Modify: `src/monitors/index.ts`

**Step 1: Add import and registration**

Add `ghibliMonitor` import and add it to the `all` array:

```typescript
import { bookeroMonitor } from "./bookero";
import { ghibliMonitor } from "./ghibli";
import { sportivoMonitor } from "./sportivo";

const all = [bookeroMonitor, ghibliMonitor, sportivoMonitor];
```

**Step 2: Commit**

```bash
git add src/monitors/index.ts
git commit -m "Register ghibli monitor"
```

---

### Task 4: Update Dockerfile for Playwright Firefox

**Files:**
- Modify: `Dockerfile`

**Step 1: Add Firefox installation step**

After `RUN bun install --frozen-lockfile`, add:

```dockerfile
# Install Firefox browser + system deps for Playwright
RUN bunx playwright install --with-deps firefox
```

Full Dockerfile:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
# Install Firefox browser + system deps for Playwright
RUN bunx playwright install --with-deps firefox
COPY . .
CMD ["bun", "run", "src/index.ts"]
```

**Step 2: Commit**

```bash
git add Dockerfile
git commit -m "Install Playwright Firefox in Docker image"
```

---

### Task 5: Update .env.example

**Files:**
- Modify: `.env.example`

**Step 1: Add MONITOR_GHIBLI**

Add `MONITOR_GHIBLI=true` alongside existing monitor flags.

**Step 2: Commit**

```bash
git add .env.example
git commit -m "Add MONITOR_GHIBLI to .env.example"
```

---

### Task 6: Integration test

**Step 1: Run locally with only the ghibli monitor**

```bash
MONITOR_BOOKERO=false MONITOR_SPORTIVO=false DB_PATH=./test-monitor.db bun run src/index.ts
```

Expected output:
```
Active monitors: ghibli
[...] [ghibli] Starting check...
[ghibli] Check done in ~4500ms (page: ~3000ms, HTTP 200). State: not_on_sale
[...] [ghibli] Current state: not_on_sale
[...] [ghibli] Previous state: (first run)
[...] [ghibli] First run, sending initial notification...
[...] [ghibli] Check complete.
```

Wait 1 minute for second tick:
```
[...] [ghibli] Starting check...
[ghibli] Skipped (next check in ~240s). Cached state: not_on_sale
[...] [ghibli] State unchanged, no notification needed
```

**Step 2: Clean up test DB**

```bash
rm test-monitor.db
```

**Step 3: Docker build test**

```bash
docker build -t website-monitor .
```

Expected: Firefox + deps install successfully in the image.

**Step 4: Deploy to Railway**

Set `MONITOR_GHIBLI=true` in Railway environment variables and deploy.

---

## Files unchanged

- `src/index.ts` — no engine changes needed. Self-throttling is handled inside the monitor's `check()` method.

## Design decisions

- **Firefox over Chromium:** Site's HTTP/2 implementation is broken, causing `ERR_HTTP2_PROTOCOL_ERROR` in Chromium. Firefox handles it fine.
- **Self-throttling over engine changes:** Module-level `lastRunAt` + `lastResult` cache avoids any changes to the shared engine code. Before 13:00 JST runs every 5 min, after 13:00 every 1 min.
- **Browser per check:** Launch and close Firefox on each real check to avoid stale browser state and memory leaks.
- **Errors throw:** No internal error handling — the engine's existing error-streak mechanism (15 min of consecutive failures → ntfy notification) handles it.
