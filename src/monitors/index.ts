import { bookeroMonitor } from "./bookero";
import { sportivoMonitor } from "./sportivo";

const all = [bookeroMonitor, sportivoMonitor];

export const monitors = all.filter((m) => {
  const envKey = `MONITOR_${m.name.toUpperCase()}`;
  return process.env[envKey] !== "false";
});
