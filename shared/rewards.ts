/**
 * Gullak Rewards — gamification shared by server and client.
 *
 * Points reward saving habits and free skill-based play. Nobody pays or
 * stakes anything to play (no "online money game"). In the demo, points can be
 * redeemed only as a *simulated* reward credit into a goal; a live product
 * would need the bank partner to fund promotional credits and approve terms.
 */

import type { ISODate } from './dates';

/** 10 points = ₹1, so 1 point = 10 paise. */
export const PAISE_PER_POINT = 10;
export const MIN_REDEEM_POINTS = 500;
export const REDEEM_STEP_POINTS = 10;
export const DAILY_REDEEM_CAP_PAISE = 200_00;
/** Contributions below this don't count toward quests, streaks or achievements. */
export const QUALIFYING_CONTRIBUTION_PAISE = 100_00;

export const LEVELS = [
  { name: 'Bronze', min: 0 },
  { name: 'Silver', min: 500 },
  { name: 'Gold', min: 1_500 },
  { name: 'Platinum', min: 4_000 },
  { name: 'Diamond', min: 10_000 },
] as const;

export function levelFor(lifetimePoints: number) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (lifetimePoints >= LEVELS[i]!.min) index = i;
  const current = LEVELS[index]!;
  const next = LEVELS[index + 1] ?? null;
  const progressPercent = next ? Math.min(100, Math.floor(((lifetimePoints - current.min) * 100) / (next.min - current.min))) : 100;
  return { index, name: current.name, min: current.min, nextName: next?.name ?? null, nextMin: next?.min ?? null, progressPercent };
}

export function pointsToPaise(points: number): number {
  return points * PAISE_PER_POINT;
}

// ---------------------------------------------------------------------------
// Coin Catch: a free 30-second skill game. The falling-item layout is derived
// from a server-issued seed, so the server can recompute any claimed score.
// ---------------------------------------------------------------------------

export const COIN_CATCH = {
  durationMs: 30_000,
  maxPointsPerGame: 60,
  rewardedPlaysPerDay: 3,
  maxSessionsPerDay: 15,
} as const;

export type FallingKind = 'coin' | 'gold' | 'trap';

export interface FallingItem {
  index: number;
  spawnMs: number;
  /** Horizontal position, 0..1 of the play-field width. */
  x: number;
  /** Time to fall from top to the catch line. */
  fallMs: number;
  kind: FallingKind;
  value: number;
}

/** Small, fast, deterministic PRNG (mulberry32). Not for security — only layout. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function coinCatchLayout(seed: number): FallingItem[] {
  const rand = seededRandom(seed);
  const items: FallingItem[] = [];
  let t = 600;
  while (t < COIN_CATCH.durationMs - 2_500) {
    const roll = rand();
    const kind: FallingKind = roll < 0.18 ? 'trap' : roll < 0.3 ? 'gold' : 'coin';
    // Items speed up a little as the round goes on.
    const progress = t / COIN_CATCH.durationMs;
    const fallMs = Math.round(2_600 - progress * 1_000 - rand() * 300);
    items.push({
      index: items.length,
      spawnMs: t,
      x: 0.08 + rand() * 0.84,
      fallMs,
      kind,
      value: kind === 'gold' ? 3 : kind === 'trap' ? -2 : 1,
    });
    t += 420 + Math.round(rand() * 380);
  }
  return items;
}

/** Score for a set of caught item indices (traps subtract; never below zero). */
export function scoreFor(layout: FallingItem[], caught: number[]): number {
  let score = 0;
  for (const i of caught) score += layout[i]?.value ?? 0;
  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export interface QuestDTO {
  id: string;
  title: string;
  description: string;
  points: number;
  progress: number;
  target: number;
  unit: 'count' | 'paise';
  status: 'in_progress' | 'claimable' | 'claimed';
}

export interface AchievementDTO {
  id: string;
  title: string;
  description: string;
  icon: string;
  points: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

export interface PointsEntryDTO {
  id: number;
  points: number;
  source: 'achievement' | 'quest' | 'quiz' | 'game' | 'redemption' | 'redemption_refund';
  note: string;
  createdAt: string;
}

export interface RewardsSummaryDTO {
  points: { balance: number; lifetimeEarned: number };
  level: ReturnType<typeof levelFor>;
  streak: { weeks: number; savedThisWeek: boolean };
  weekStart: ISODate;
  weekEnd: ISODate;
  quests: QuestDTO[];
  achievements: AchievementDTO[];
  newlyUnlocked: string[];
  games: {
    quiz: { playedToday: boolean };
    coinCatch: { playsToday: number; rewardedPlaysLeft: number; maxPointsPerGame: number };
  };
  redemption: { paisePerPoint: number; minPoints: number; stepPoints: number; dailyCapPaise: number; redeemedTodayPaise: number };
  history: PointsEntryDTO[];
}

export interface QuizQuestionDTO {
  id: string;
  prompt: string;
  options: string[];
}

export interface QuizStartDTO {
  sessionId: string;
  questions: QuizQuestionDTO[];
}

export interface QuizResultDTO {
  correct: number;
  total: number;
  pointsAwarded: number;
  results: Array<{ id: string; chosen: number; answer: number; explanation: string }>;
}

export interface CoinCatchStartDTO {
  sessionId: string;
  seed: number;
  durationMs: number;
  rewarded: boolean;
}

export interface CoinCatchResultDTO {
  score: number;
  pointsAwarded: number;
  rewarded: boolean;
}

export interface SavingsHistoryDTO {
  range: '1m' | '3m' | '6m' | '1y';
  points: Array<{ date: ISODate; balancePaise: number }>;
  startBalancePaise: number;
  endBalancePaise: number;
  changePaise: number;
}
