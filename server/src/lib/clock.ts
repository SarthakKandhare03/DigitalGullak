import { todayInIST } from '../../../shared/dates';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

export function todayIST(clock: Clock): string {
  return todayInIST(clock.now());
}

/** Test clock that only moves when told to. */
export class ManualClock implements Clock {
  private current: Date;
  constructor(start: string | Date = '2026-10-18T05:30:00.000Z') {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(to: string | Date): void {
    this.current = new Date(to);
  }
}
