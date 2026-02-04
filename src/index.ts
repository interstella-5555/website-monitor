import { Database } from "bun:sqlite";
import { CronJob } from "cron";

const DB_PATH = process.env.DB_PATH ?? "/data/sportivo.db";
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const TEST_MODE = process.env.TEST_MODE === "true";
const FORCE_STATE = process.env.FORCE_STATE as "open" | "closed" | undefined;
const TARGET_URL = "https://s-sportivo.pl/czlonkostwo/";
const CLOSED_TEXT = "Rejestracja jest obecnie wyłączona";

type State = "open" | "closed";

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

async function checkRegistration(): Promise<State> {
  if (FORCE_STATE) {
    log(`FORCE_STATE is set to "${FORCE_STATE}", skipping fetch`);
    return FORCE_STATE;
  }

  log(`Fetching ${TARGET_URL}...`);

  const response = await fetch(TARGET_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10_000),
  });

  const body = await response.text();
  log(`Response: ${response.status} ${response.statusText} (${body.length} bytes)`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const containsClosed = body.includes(CLOSED_TEXT);
  log(`Page contains "wyłączona": ${containsClosed}`);

  return containsClosed ? "closed" : "open";
}

async function notify(state: State, previousState: State | null): Promise<void> {
  if (!NTFY_TOPIC) {
    log("WARNING: NTFY_TOPIC not set, skipping notification");
    return;
  }

  const isOpen = state === "open";
  const title = isOpen ? "Rejestracja OTWARTA!" : "Rejestracja zamknięta";
  const priority = isOpen ? "5" : "4";
  const tags = isOpen ? "tada" : "warning";

  let message: string;
  if (previousState === null) {
    message = `Pierwsze sprawdzenie. Aktualny stan: ${isOpen ? "rejestracja otwarta" : "rejestracja zamknięta"}.`;
  } else {
    message = isOpen
      ? "Rejestracja w S-Sportivo została właśnie otwarta! Wejdź na stronę i się zapisz."
      : "Rejestracja w S-Sportivo została zamknięta.";
  }

  const response = await fetch(`https://ntfy.sh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message,
      priority: Number(priority),
      tags: [tags],
      click: TARGET_URL,
    }),
  });

  log(`ntfy response: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    throw new Error(`ntfy error: ${response.status} ${response.statusText}`);
  }

  log("Notification sent successfully!");
}

async function sendTestNotification(): Promise<void> {
  if (!NTFY_TOPIC) {
    log("WARNING: NTFY_TOPIC not set, skipping test notification");
    return;
  }

  log("TEST_MODE: Sending test notification...");

  const response = await fetch(`https://ntfy.sh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: "Test: monitor działa!",
      message: "Sportivo monitor jest aktywny i wysyła powiadomienia poprawnie.",
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
    const currentState = await checkRegistration();
    log(`Current state: ${currentState}`);

    const previousState = getLastState(db);
    log(`Previous state: ${previousState ?? "(first run)"}`);

    if (previousState === null) {
      log("First run, sending initial notification...");
      await notify(currentState, null);
      saveState(db, currentState, true);
    } else if (currentState !== previousState) {
      log("STATE CHANGED! Sending notification...");
      await notify(currentState, previousState);
      saveState(db, currentState, true);
    } else {
      log("State unchanged, no notification needed");
      if (TEST_MODE) {
        log("TEST_MODE: Sending debug ping...");
        await sendTestNotification();
      }
      saveState(db, currentState, false);
    }

    log("Check complete.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${message}`);
    log("Skipping this check, will retry next cycle.");
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
