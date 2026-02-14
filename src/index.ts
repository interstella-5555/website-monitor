import { Database } from "bun:sqlite";
import { CronJob } from "cron";
import { monitors } from "./monitors";

export interface CheckResult {
  state: string;
  detail: string;
}

export interface Monitor {
  name: string;
  url: string;
  check(): Promise<CheckResult>;
  notification(
    result: CheckResult,
    previousState: string | null,
  ): { title: string; message: string; priority: number; tags: string[] };
}

const DB_PATH = process.env.DB_PATH ?? "/data/monitor.db";
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_DEBUG_TOPIC = process.env.NTFY_DEBUG_TOPIC;

function log(monitor: string, message: string): void {
  const now = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  console.log(`[${now}] [${monitor}] ${message}`);
}

function initDb(): Database {
  const db = new Database(DB_PATH, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor TEXT NOT NULL,
      state TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      notified INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS error_streak (
      monitor TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function getLastState(db: Database, monitorName: string): string | null {
  const row = db
    .query<{ state: string }, [string]>(
      "SELECT state FROM checks WHERE monitor = ? ORDER BY id DESC LIMIT 1",
    )
    .get(monitorName);
  return row?.state ?? null;
}

function saveState(
  db: Database,
  monitorName: string,
  state: string,
  notified: boolean,
): void {
  db.run("INSERT INTO checks (monitor, state, notified) VALUES (?, ?, ?)", [
    monitorName,
    state,
    notified ? 1 : 0,
  ]);
}

async function sendNotification(
  payload: {
    title: string;
    message: string;
    priority: number;
    tags: string[];
    click: string;
  },
  topic?: string,
): Promise<void> {
  const t = topic ?? NTFY_TOPIC;
  if (!t) return;

  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: t, ...payload }),
  });

  if (!response.ok) {
    throw new Error(`ntfy error: ${response.status} ${response.statusText}`);
  }
}

async function notifyError(
  monitorName: string,
  errorMessage: string,
): Promise<void> {
  if (!NTFY_TOPIC) return;

  await sendNotification({
    title: `${monitorName}: niedostępne!`,
    message: `Monitor "${monitorName}" nie odpowiada od 15 minut. Ostatni błąd: ${errorMessage}`,
    priority: 4,
    tags: ["rotating_light"],
    click: "",
  });

  log(monitorName, "Error notification sent!");
}

async function notifyRecovery(monitor: Monitor): Promise<void> {
  if (!NTFY_TOPIC) return;

  await sendNotification({
    title: `${monitor.name}: znów działa`,
    message: `Monitor "${monitor.name}" znów odpowiada po przerwie.`,
    priority: 3,
    tags: ["white_check_mark"],
    click: monitor.url,
  });

  log(monitor.name, "Recovery notification sent!");
}

async function runCheck(monitor: Monitor, db: Database): Promise<void> {
  log(monitor.name, "Starting check...");

  try {
    const result = await monitor.check();
    log(monitor.name, `Current state: ${result.state}`);

    // Check if recovering from error streak
    const streak = db
      .query<{ notified: number }, [string]>(
        "SELECT notified FROM error_streak WHERE monitor = ?",
      )
      .get(monitor.name);
    if (streak?.notified) {
      log(monitor.name, "Recovering from error streak...");
      await notifyRecovery(monitor);
    }
    db.run("DELETE FROM error_streak WHERE monitor = ?", [monitor.name]);

    const previousState = getLastState(db, monitor.name);
    log(monitor.name, `Previous state: ${previousState ?? "(first run)"}`);

    if (previousState === null) {
      log(monitor.name, "First run, sending initial notification...");
      const payload = monitor.notification(result, null);
      await sendNotification({ ...payload, click: monitor.url });
      saveState(db, monitor.name, result.state, true);
    } else if (result.state !== previousState) {
      log(monitor.name, "STATE CHANGED! Sending notification...");
      const payload = monitor.notification(result, previousState);
      await sendNotification({ ...payload, click: monitor.url });
      saveState(db, monitor.name, result.state, true);
    } else {
      log(monitor.name, "State unchanged, no notification needed");
      if (NTFY_DEBUG_TOPIC) {
        const payload = monitor.notification(result, previousState);
        await sendNotification({ ...payload, click: monitor.url }, NTFY_DEBUG_TOPIC);
      }
      saveState(db, monitor.name, result.state, false);
    }

    log(monitor.name, "Check complete.");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(monitor.name, `ERROR: ${errorMsg}`);

    const streak = db
      .query<{ started_at: string; notified: number }, [string]>(
        "SELECT started_at, notified FROM error_streak WHERE monitor = ?",
      )
      .get(monitor.name);

    if (!streak) {
      db.run(
        "INSERT INTO error_streak (monitor, started_at) VALUES (?, datetime('now'))",
        [monitor.name],
      );
      log(monitor.name, "Error streak started.");
    } else if (!streak.notified) {
      const overdue = db
        .query<{ past: number }, [string]>(
          "SELECT started_at <= datetime('now', '-15 minutes') AS past FROM error_streak WHERE monitor = ?",
        )
        .get(monitor.name);
      if (overdue?.past) {
        log(monitor.name, "15 minutes of errors, sending error notification...");
        await notifyError(monitor.name, errorMsg);
        db.run("UPDATE error_streak SET notified = 1 WHERE monitor = ?", [
          monitor.name,
        ]);
      } else {
        log(monitor.name, "Error streak ongoing, not yet 15 minutes.");
      }
    } else {
      log(monitor.name, "Error streak ongoing, notification already sent.");
    }
  }
}

async function runAllChecks(): Promise<void> {
  const db = initDb();
  try {
    for (const monitor of monitors) {
      await runCheck(monitor, db);
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (monitors.length === 0) {
    console.log("No monitors enabled. Set MONITOR_<NAME>=true or remove =false flags.");
    process.exit(1);
  }

  console.log(
    `Active monitors: ${monitors.map((m) => m.name).join(", ")}`,
  );

  await runAllChecks();

  const job = CronJob.from({
    cronTime: "* * * * *",
    onTick: runAllChecks,
    start: true,
  });

  const next = job.nextDate().toFormat("HH:mm:ss");
  console.log(`Scheduled every minute. Next check at ${next}`);
}

main();
