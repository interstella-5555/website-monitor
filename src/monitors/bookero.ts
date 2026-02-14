import type { Monitor, CheckResult } from "../index";

const BOOKERO_URL = "https://felican_kajetan_radajewski.bookero.pl/";
const API_BASE = "https://plugin.bookero.pl/plugin-api/v2";
const BOOKERO_ID = "f08vudX3f5XI";
const SERVICE_ID = "56550";

interface AvailableSlot {
  date: string;
  day: string;
  hours: string[];
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

  const response = await fetch(`${API_BASE}/getMonth?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function formatSlots(slots: AvailableSlot[]): string {
  return slots
    .map((s) => `${s.date} (${s.day}): ${s.hours.join(", ")}`)
    .join("\n");
}

export const bookeroMonitor: Monitor = {
  name: "bookero",
  url: BOOKERO_URL,

  async check(): Promise<CheckResult> {
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

    return {
      state: slots.length > 0 ? "available" : "unavailable",
      detail:
        slots.length > 0
          ? `Dostępne terminy:\n${formatSlots(slots)}`
          : "Brak wolnych terminów",
    };
  },

  notification(result, previousState) {
    const isAvailable = result.state === "available";
    let message: string;

    if (previousState === null) {
      message = isAvailable
        ? `Pierwsze sprawdzenie. ${result.detail}`
        : "Pierwsze sprawdzenie. Brak wolnych terminów.";
    } else {
      message = isAvailable
        ? `Pojawiły się wolne terminy USG!\n${result.detail}`
        : "Wszystkie terminy USG są obecnie zamknięte.";
    }

    return {
      title: isAvailable ? "Wolne terminy USG!" : "Terminy USG zamknięte",
      message,
      priority: isAvailable ? 5 : 4,
      tags: isAvailable ? ["tada"] : ["warning"],
    };
  },
};
