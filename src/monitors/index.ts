import { bookeroMonitor } from "./bookero";
import { ghibliMonitor } from "./ghibli";
import { sportivoMonitor } from "./sportivo";

const all = [bookeroMonitor, ghibliMonitor, sportivoMonitor];

export const monitors = all.filter((m) => {
  const envKey = `MONITOR_${m.name.toUpperCase()}`;
  return process.env[envKey] === "true";
});
