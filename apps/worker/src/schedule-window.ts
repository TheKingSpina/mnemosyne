// Night-window gating for the analyzer: "HH:MM-HH:MM" in the container's
// local time, wrapping midnight when start >= end. Without a window the
// schedule keeps working interval-only, so this is opt-in per deployment.
export interface AnalyzerWindow {
  startMinute: number;
  endMinute: number;
}

export function parseAnalyzerWindow(value: string): AnalyzerWindow {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error(`analyzer_window_invalid:${value}`);
  const parts = [match[1], match[3]].map(Number);
  const minutes = [match[2], match[4]].map(Number);
  for (const [hour, minute] of [
    [parts[0], minutes[0]],
    [parts[1], minutes[1]],
  ]) {
    if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) {
      throw new Error(`analyzer_window_invalid:${value}`);
    }
  }
  return { startMinute: parts[0] * 60 + minutes[0], endMinute: parts[1] * 60 + minutes[1] };
}

export function isInAnalyzerWindow(date: Date, window: AnalyzerWindow): boolean {
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  // start == end is the explicit way to write an empty window (never inside);
  // for always-on, omit the window and let the interval run alone.
  if (window.startMinute <= window.endMinute) {
    return minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute;
  }
  return minuteOfDay >= window.startMinute || minuteOfDay < window.endMinute;
}

// When the analyzer would next be due: inside the window it is the interval;
// outside it is the next window opening, so the run fires right when the
// window opens instead of after a full week of waiting plus checking.
export function nextAnalyzerDueAt(
  date: Date,
  window: AnalyzerWindow | null,
  intervalMs: number,
): number {
  const now = date.getTime();
  if (!window || isInAnalyzerWindow(date, window)) return now + intervalMs;
  const todayAtStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  todayAtStart.setMinutes(window.startMinute);
  if (todayAtStart.getTime() > now) return todayAtStart.getTime();
  const tomorrowAtStart = new Date(todayAtStart);
  tomorrowAtStart.setDate(tomorrowAtStart.getDate() + 1);
  return tomorrowAtStart.getTime();
}
