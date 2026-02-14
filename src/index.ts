import { Database } from "bun:sqlite";
import { CronJob } from "cron";

const DB_PATH = process.env.DB_PATH ?? "/data/sportivo.db";
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const TEST_MODE = process.env.TEST_MODE === "true";
const FORCE_STATE = process.env.FORCE_STATE as "available" | "unavailable" | undefined;

const BOOKERO_URL = "https://felican_kajetan_radajewski.bookero.pl/";
const API_BASE = "https://plugin.bookero.pl/plugin-api/v2";
const BOOKERO_ID = "f08vudX3f5XI";
const SERVICE_ID = "56550";

type State = "available" | "unavailable";

interface AvailableSlot {
  date: string;
  day: string;
  hours: string[];
}

interface CheckResult {
  state: State;
  slots: AvailableSlot[];
}

function log(message: string): void {
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  console.log(`[${now}] ${message}`);
}

function initDb(): Database {
  const db = new Database(DB_PATH, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      notified INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS error_streak (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      started_at TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function getLastState(db: Database): State | null {
  const row = db
    .query<{ state: string }, []>("SELECT state FROM checks ORDER BY id DESC LIMIT 1")
    .get();
  return (row?.state as State) ?? null;
}

function saveState(db: Database, state: State, notified: boolean): void {
  db.run("INSERT INTO checks (state, notified) VALUES (?, ?)", [state, notified ? 1 : 0]);
}

async function fetchMonth(plusMonths: number): Promise<any> {
  const params = new URLSearchParams({
    bookero_id: BOOKERO_ID,
    service: SERVICE_ID,
    lang: "pl",
    periodicity_id: "0",
    custom_duration_id: "0",
    worker: "0",
    plugin_comment: "",
    phone: "",
    people: "1",
    email: "",
    plus_months: String(plusMonths),
  });

  const url = `${API_BASE}/getMonth?${params}`;
  log(`Fetching getMonth (plus_months=${plusMonths})...`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  log(`getMonth(${plusMonths}): valid_month=${data.valid_month}, days=${data.days ? Object.keys(data.days).length : 0}`);
  return data;
}

async function checkAvailability(): Promise<CheckResult> {
  if (FORCE_STATE) {
    log(`FORCE_STATE is set to "${FORCE_STATE}", skipping fetch`);
    return { state: FORCE_STATE, slots: [] };
  }

  const slots: AvailableSlot[] = [];

  for (const plusMonths of [0, 1]) {
    const data = await fetchMonth(plusMonths);

    if (!data.valid_month || !data.days) continue;

    for (const day of Object.values(data.days) as any[]) {
      if (day.valid_day > 0 && day.hours && day.hours.length > 0) {
        slots.push({
          date: day.date,
          day: day.day ?? "",
          hours: day.hours.map((h: any) => h.hour ?? h),
        });
      }
    }
  }

  log(`Found ${slots.length} day(s) with available slots`);
  return {
    state: slots.length > 0 ? "available" : "unavailable",
    slots,
  };
}

function formatSlots(slots: AvailableSlot[]): string {
  return slots
    .map((s) => `${s.date} (${s.day}): ${s.hours.join(", ")}`)
    .join("\n");
}

async function notify(result: CheckResult, previousState: State | null): Promise<void> {
  if (!NTFY_TOPIC) {
    log("WARNING: NTFY_TOPIC not set, skipping notification");
    return;
  }

  const isAvailable = result.state === "available";
  const title = isAvailable ? "Wolne terminy USG!" : "Terminy USG zamknięte";
  const priority = isAvailable ? 5 : 4;
  const tags = isAvailable ? ["tada"] : ["warning"];

  let message: string;
  if (previousState === null) {
    message = isAvailable
      ? `Pierwsze sprawdzenie. Dostępne terminy:\n${formatSlots(result.slots)}`
      : "Pierwsze sprawdzenie. Brak wolnych terminów.";
  } else {
    message = isAvailable
      ? `Pojawiły się wolne terminy USG!\n${formatSlots(result.slots)}`
      : "Wszystkie terminy USG są obecnie zamknięte.";
  }

  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message,
      priority,
      tags,
      click: BOOKERO_URL,
    }),
  });

  log(`ntfy response: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    throw new Error(`ntfy error: ${response.status} ${response.statusText}`);
  }

  log("Notification sent successfully!");
}

async function notifyError(errorMessage: string): Promise<void> {
  if (!NTFY_TOPIC) return;

  await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: "Bookero niedostępne!",
      message: `API Bookero nie odpowiada od 15 minut. Ostatni błąd: ${errorMessage}`,
      priority: 4,
      tags: ["rotating_light"],
    }),
  });

  log("Error notification sent!");
}

async function notifyRecovery(): Promise<void> {
  if (!NTFY_TOPIC) return;

  await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: "Bookero znów działa",
      message: "API Bookero (weterynarz) znów odpowiada po przerwie.",
      priority: 3,
      tags: ["white_check_mark"],
    }),
  });

  log("Recovery notification sent!");
}

async function sendTestNotification(): Promise<void> {
  if (!NTFY_TOPIC) {
    log("WARNING: NTFY_TOPIC not set, skipping test notification");
    return;
  }

  log("TEST_MODE: Sending test notification...");

  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: "Test: Bookero monitor działa!",
      message: "Monitor terminów USG jest aktywny i wysyła powiadomienia poprawnie.",
      priority: 3,
      tags: ["white_check_mark"],
    }),
  });

  log(`Test ntfy response: ${response.status} ${response.statusText}`);
}

async function runCheck(): Promise<void> {
  log("Starting check...");
  const db = initDb();

  try {
    const result = await checkAvailability();
    log(`Current state: ${result.state}`);

    // Check if we're recovering from an error streak
    const streak = db
      .query<{ notified: number }, []>("SELECT notified FROM error_streak WHERE id = 1")
      .get();
    if (streak?.notified) {
      log("Recovering from error streak, sending recovery notification...");
      await notifyRecovery();
    }
    db.run("DELETE FROM error_streak");

    const previousState = getLastState(db);
    log(`Previous state: ${previousState ?? "(first run)"}`);

    if (previousState === null) {
      log("First run, sending initial notification...");
      await notify(result, null);
      saveState(db, result.state, true);
    } else if (result.state !== previousState) {
      log("STATE CHANGED! Sending notification...");
      await notify(result, previousState);
      saveState(db, result.state, true);
    } else {
      log("State unchanged, no notification needed");
      if (TEST_MODE) {
        log("TEST_MODE: Sending status notification anyway...");
        await notify(result, previousState);
      }
      saveState(db, result.state, false);
    }

    log("Check complete.");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMsg}`);

    const streak = db
      .query<{ started_at: string; notified: number }, []>(
        "SELECT started_at, notified FROM error_streak WHERE id = 1"
      )
      .get();

    if (!streak) {
      db.run("INSERT INTO error_streak (id, started_at) VALUES (1, datetime('now'))");
      log("Error streak started.");
    } else if (!streak.notified) {
      const overdue = db
        .query<{ past: number }, []>(
          "SELECT started_at <= datetime('now', '-15 minutes') AS past FROM error_streak WHERE id = 1"
        )
        .get();
      if (overdue?.past) {
        log("15 minutes of errors, sending error notification...");
        await notifyError(errorMsg);
        db.run("UPDATE error_streak SET notified = 1 WHERE id = 1");
      } else {
        log("Error streak ongoing, not yet 15 minutes.");
      }
    } else {
      log("Error streak ongoing, notification already sent.");
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (TEST_MODE) {
    await sendTestNotification();
  }

  await runCheck();

  const job = CronJob.from({
    cronTime: "* * * * *",
    onTick: runCheck,
    start: true,
  });

  const next = job.nextDate().toFormat("HH:mm:ss");
  log(`Monitor started, scheduled every minute. Next check at ${next}`);
}

main();
