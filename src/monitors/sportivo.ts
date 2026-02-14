import type { Monitor, CheckResult } from "../index";

const TARGET_URL = "https://s-sportivo.pl/czlonkostwo/";
const CLOSED_TEXT = "Rejestracja jest obecnie wyłączona";

export const sportivoMonitor: Monitor = {
  name: "sportivo",
  url: TARGET_URL,

  async check(): Promise<CheckResult> {
    const response = await fetch(TARGET_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const body = await response.text();
    const isClosed = body.includes(CLOSED_TEXT);

    return {
      state: isClosed ? "closed" : "open",
      detail: isClosed ? "Rejestracja zamknięta" : "Rejestracja otwarta",
    };
  },

  notification(result, previousState) {
    const isOpen = result.state === "open";
    let message: string;

    if (previousState === null) {
      message = `Pierwsze sprawdzenie. Aktualny stan: ${result.detail.toLowerCase()}.`;
    } else {
      message = isOpen
        ? "Rejestracja w S-Sportivo została właśnie otwarta! Wejdź na stronę i się zapisz."
        : "Rejestracja w S-Sportivo została zamknięta.";
    }

    return {
      title: isOpen ? "Rejestracja OTWARTA!" : "Rejestracja zamknięta",
      message,
      priority: isOpen ? 5 : 4,
      tags: isOpen ? ["tada"] : ["warning"],
    };
  },
};
