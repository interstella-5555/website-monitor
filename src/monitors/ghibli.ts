import { firefox } from "playwright";
import { getHours } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type { Monitor, CheckResult } from "../index";

const GHIBLI_URL = "https://l-tike.com/st1/ghibli-pk-en4/sitetop";
const TARGET_MONTH = process.env.GHIBLI_TARGET_MONTH ?? "May";
const TARGET_YEAR = process.env.GHIBLI_TARGET_YEAR ?? "2026";

const MONTH_TO_NUM: Record<string, string> = {
  January: "1", February: "2", March: "3", April: "4",
  May: "5", June: "6", July: "7", August: "8",
  September: "9", October: "10", November: "11", December: "12",
};

type TicketState = "not_on_sale" | "on_sale" | "sold_out" | "unknown";

let lastRunAt = 0;
let lastResult: CheckResult | null = null;

function getJSTHour(): number {
  return getHours(toZonedTime(new Date(), "Asia/Tokyo"));
}

function getThrottleInterval(): number {
  return getJSTHour() >= 13 ? 60 : 300;
}

function normalizeFullWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .replace(/[\u300C\u300D]/g, "")
    .replace(/[【】\[\]]/g, (ch) => ch === "【" || ch === "[" ? "[" : "]")
    .replace(/\uFF0D|\u2010|\u2011|\u2012|\u2013|\u2014|\u2015|\u2212/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function detectStatus(text: string): TicketState {
  if (text.includes("Not Yet On Sale")) return "not_on_sale";
  if (text.includes("Sold Out")) return "sold_out";
  if (text.includes("On Sale")) return "on_sale";
  return "unknown";
}

function splitSections(normalized: string): string[] {
  return normalized.split(/(?=\[)/).filter((s) => s.startsWith("["));
}

// Method 1: find Premium by title regex
function findPremiumByTitle(sections: string[]): TicketState | null {
  const re = new RegExp(`^\\[${TARGET_MONTH}\\]\\s*Ghibli\\s+Park\\s+O.Sanpo\\s+Day\\s+Pass\\s+Premium`, "i");
  for (const section of sections) {
    if (re.test(section)) return detectStatus(section);
  }
  return null;
}

// Method 2: find tickets by event date
function findByDate(sections: string[]): { premium: TicketState | null; standard: TicketState | null } {
  const monthNum = MONTH_TO_NUM[TARGET_MONTH];
  if (!monthNum) return { premium: null, standard: null };

  const datePattern = `${TARGET_YEAR}/${monthNum}/`;
  let premium: TicketState | null = null;
  let standard: TicketState | null = null;

  for (const section of sections) {
    if (!section.includes(datePattern)) continue;
    if (/Premium/i.test(section)) premium = detectStatus(section);
    else if (/Standard/i.test(section)) standard = detectStatus(section);
  }

  return { premium, standard };
}

const STATE_LABEL: Record<TicketState, string> = {
  not_on_sale: "Not Yet On Sale",
  on_sale: "ON SALE",
  sold_out: "Sold Out",
  unknown: "???",
};

function extractTicketTitles(pageText: string): string[] {
  return pageText.match(/[【\[][^】\]]+[】\]][^\n]*/g) ?? [];
}

interface ParseResult {
  premium: TicketState;
  standard: TicketState;
  method: string;
}

function parseTickets(pageText: string): ParseResult | null {
  const normalized = normalizeFullWidth(pageText);
  const sections = splitSections(normalized);

  // Primary: Premium by title
  const premiumByTitle = findPremiumByTitle(sections);
  if (premiumByTitle !== null) {
    const byDate = findByDate(sections);
    return {
      premium: premiumByTitle,
      standard: byDate.standard ?? "unknown",
      method: "title",
    };
  }

  // Fallback: both by event date
  const byDate = findByDate(sections);
  if (byDate.premium !== null || byDate.standard !== null) {
    return {
      premium: byDate.premium ?? "unknown",
      standard: byDate.standard ?? "unknown",
      method: "date",
    };
  }

  return null;
}

function encodeState(premium: TicketState, standard: TicketState): string {
  return `premium:${premium}|standard:${standard}`;
}

function decodeState(state: string): { premium: TicketState; standard: TicketState } | null {
  const match = state.match(/^premium:(\w+)\|standard:(\w+)$/);
  if (!match) return null;
  return { premium: match[1] as TicketState, standard: match[2] as TicketState };
}

function formatPair(premium: TicketState, standard: TicketState): string {
  return `Premium: ${STATE_LABEL[premium]}\nStandard: ${STATE_LABEL[standard]}`;
}

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
    const parsed = parseTickets(pageText);
    const totalMs = Math.round(performance.now() - checkStart);

    if (parsed) {
      const state = encodeState(parsed.premium, parsed.standard);
      console.log(
        `[ghibli] Done in ${totalMs}ms (page: ${pageLoadMs}ms, HTTP ${httpStatus}). ` +
        `Method: ${parsed.method}. ${state}`,
      );
      return { state, detail: `${formatPair(parsed.premium, parsed.standard)}\n(via ${parsed.method})` };
    }

    // Both methods failed
    const titles = extractTicketTitles(pageText);
    const normalized = normalizeFullWidth(pageText);
    const context = titles.length > 0
      ? `Tickets on page:\n${titles.join("\n")}`
      : `Page text (first 500 chars):\n${normalized.slice(0, 500)}`;

    console.log(
      `[ghibli] Done in ${totalMs}ms (page: ${pageLoadMs}ms, HTTP ${httpStatus}). ` +
      `${TARGET_MONTH} ${TARGET_YEAR} tickets NOT FOUND`,
    );
    console.log(`[ghibli] Context: ${context}`);

    return { state: "page_changed", detail: context };
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
    if (result.state === "page_changed") {
      return {
        title: `Ghibli ${TARGET_MONTH}: page changed!`,
        message: result.detail,
        priority: 5,
        tags: ["warning"],
      };
    }

    const current = decodeState(result.state);
    if (!current) {
      return {
        title: `Ghibli ${TARGET_MONTH}: unknown state`,
        message: result.state,
        priority: 4,
        tags: ["warning"],
      };
    }

    const hasOnSale = current.premium === "on_sale" || current.standard === "on_sale";
    const allSoldOut = current.premium === "sold_out" && current.standard === "sold_out";

    if (hasOnSale) {
      const parts: string[] = [];
      if (current.premium === "on_sale") parts.push("Premium ON SALE!");
      if (current.standard === "on_sale") parts.push("Standard ON SALE!");
      if (current.premium !== "on_sale") parts.push(`Premium: ${STATE_LABEL[current.premium]}`);
      if (current.standard !== "on_sale") parts.push(`Standard: ${STATE_LABEL[current.standard]}`);

      return {
        title: `Ghibli ${TARGET_MONTH}: tickets ON SALE!`,
        message: parts.join("\n"),
        priority: 5,
        tags: ["tada"],
      };
    }

    if (allSoldOut) {
      return {
        title: `Ghibli ${TARGET_MONTH}: all sold out`,
        message: formatPair(current.premium, current.standard),
        priority: 4,
        tags: ["warning"],
      };
    }

    const isFirst = previousState === null;
    return {
      title: `Ghibli ${TARGET_MONTH}: ${isFirst ? "status check" : "status changed"}`,
      message: formatPair(current.premium, current.standard),
      priority: 3,
      tags: ["hourglass"],
    };
  },
};
