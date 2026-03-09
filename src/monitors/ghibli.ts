import { firefox } from "playwright";
import type { Monitor, CheckResult } from "../index";

const GHIBLI_URL = "https://l-tike.com/st1/ghibli-pk-en4/sitetop";
const TARGET_TICKET = "【Ｍａｙ】Ｇｈｉｂｌｉ　Ｐａｒｋ　Ｏ－Ｓａｎｐｏ　Ｄａｙ　Ｐａｓｓ　Ｐｒｅｍｉｕｍ";

type GhibliState = "not_on_sale" | "on_sale" | "sold_out" | "page_changed";

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
  if (idx === -1) return "page_changed";

  const afterTicket = pageText.slice(idx + TARGET_TICKET.length);
  const nextSection = afterTicket.indexOf("【");
  const section = nextSection !== -1 ? afterTicket.slice(0, nextSection) : afterTicket;

  if (section.includes("Not Yet On Sale")) return "not_on_sale";
  if (section.includes("On Sale")) return "on_sale";
  if (section.includes("Sold Out")) return "sold_out";

  return "page_changed";
}

const stateLabels: Record<GhibliState, string> = {
  not_on_sale: "Not Yet On Sale",
  on_sale: "On Sale",
  sold_out: "Sold Out",
  page_changed: "Page changed — ticket text not found!",
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

    if (state === "page_changed") {
      return {
        title: "Ghibli Park: page changed!",
        message:
          "Target ticket text not found on page. The site may have changed — check manually!",
        priority: 5,
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
