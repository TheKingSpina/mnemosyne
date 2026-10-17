import { describe, expect, it } from 'vitest';
import { isInAnalyzerWindow, nextAnalyzerDueAt, parseAnalyzerWindow } from './schedule-window.js';

const DAY_MS = 86_400_000;

function local(h: number, m: number): Date {
  const date = new Date(2026, 9, 17, h, m, 0, 0);
  return date;
}

describe('parseAnalyzerWindow', () => {
  it('accepts start-end in container local time', () => {
    expect(parseAnalyzerWindow('03:30-06:00')).toEqual({ startMinute: 210, endMinute: 360 });
  });

  it('rejects anything that is not an hour range', () => {
    expect(() => parseAnalyzerWindow('night')).toThrow('analyzer_window_invalid');
    expect(() => parseAnalyzerWindow('25:00-06:00')).toThrow('analyzer_window_invalid');
    expect(() => parseAnalyzerWindow('03:60-06:00')).toThrow('analyzer_window_invalid');
  });
});

describe('isInAnalyzerWindow', () => {
  const day = parseAnalyzerWindow('03:30-06:00');
  const wrap = parseAnalyzerWindow('22:00-02:00');

  it('answers true strictly inside, false on and after the end', () => {
    expect(isInAnalyzerWindow(local(3, 29), day)).toBe(false);
    expect(isInAnalyzerWindow(local(3, 30), day)).toBe(true);
    expect(isInAnalyzerWindow(local(5, 59), day)).toBe(true);
    expect(isInAnalyzerWindow(local(6, 0), day)).toBe(false);
  });

  it('wraps midnight', () => {
    expect(isInAnalyzerWindow(local(21, 59), wrap)).toBe(false);
    expect(isInAnalyzerWindow(local(23, 0), wrap)).toBe(true);
    expect(isInAnalyzerWindow(local(1, 59), wrap)).toBe(true);
    expect(isInAnalyzerWindow(local(2, 0), wrap)).toBe(false);
  });
});

describe('nextAnalyzerDueAt', () => {
  const day = parseAnalyzerWindow('03:30-06:00');

  it('keeps using the interval inside the window', () => {
    const at = local(4, 0);
    expect(nextAnalyzerDueAt(at, day, DAY_MS)).toBe(at.getTime() + DAY_MS);
  });

  it('parks the run at the next window opening when outside', () => {
    expect(nextAnalyzerDueAt(local(8, 0), day, DAY_MS)).toBe(local(3, 30).getTime() + DAY_MS);
    expect(nextAnalyzerDueAt(local(2, 0), day, DAY_MS)).toBe(local(3, 30).getTime());
  });

  it('behaves interval-only without a window', () => {
    const at = local(12, 0);
    expect(nextAnalyzerDueAt(at, null, DAY_MS)).toBe(at.getTime() + DAY_MS);
  });
});
