import { randomInt } from 'node:crypto';
import { addDays, todayInIST, weekdayOf, type ISODate } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import {
  COIN_CATCH,
  DAILY_REDEEM_CAP_PAISE,
  MIN_REDEEM_POINTS,
  PAISE_PER_POINT,
  QUALIFYING_CONTRIBUTION_PAISE,
  REDEEM_STEP_POINTS,
  coinCatchLayout,
  levelFor,
  pointsToPaise,
  scoreFor,
  seededRandom,
  type AchievementDTO,
  type CoinCatchResultDTO,
  type CoinCatchStartDTO,
  type PointsEntryDTO,
  type QuestDTO,
  type QuizResultDTO,
  type QuizStartDTO,
  type RewardsSummaryDTO,
} from '../../../shared/rewards';
import type { CreateTransferResponse } from '../../../shared/types';
import { all, one, run, tx, type DB } from '../db/db';
import type { LedgerService } from '../ledger/ledgerService';
import { nowIso, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import { conflict, notFound, tooManyRequests, unprocessable } from '../lib/errors';
import { PERFECT_BONUS, POINTS_PER_CORRECT, QUIZ_BANK, QUIZ_LENGTH } from './quizBank';

type Source = PointsEntryDTO['source'];

interface Context {
  personalGoals: number;
  userSchedules: number;
  qualifyingCount: number;
  qualifyingPaise: number;
  postedPaise: number;
  bestGoalPercent: number;
  reachedGoal: boolean;
  streakWeeks: number;
  perfectQuiz: boolean;
  bestCoinScore: number;
}

const ACHIEVEMENTS: Array<{ id: string; title: string; description: string; icon: string; points: number; test: (c: Context) => boolean }> = [
  { id: 'first_goal', title: 'Dream it', description: 'Create your first goal', icon: '🎯', points: 50, test: (c) => c.personalGoals >= 1 },
  { id: 'first_save', title: 'First coin', description: `Save ${formatINR(QUALIFYING_CONTRIBUTION_PAISE)} or more`, icon: '🪙', points: 100, test: (c) => c.qualifyingCount >= 1 },
  { id: 'schedule_set', title: 'On autopilot', description: 'Set up a savings schedule', icon: '🔁', points: 100, test: (c) => c.userSchedules >= 1 },
  { id: 'goal_quarter', title: 'Quarter way', description: 'Reach 25% of a goal (₹500+ target)', icon: '🌱', points: 100, test: (c) => c.bestGoalPercent >= 25 },
  { id: 'saved_1k', title: 'Thousand club', description: 'Have ₹1,000 saved', icon: '💰', points: 150, test: (c) => c.postedPaise >= 1_000_00 && c.qualifyingPaise >= 1_000_00 },
  { id: 'streak_4', title: 'Steady saver', description: 'Save in 4 weeks in a row', icon: '🔥', points: 300, test: (c) => c.streakWeeks >= 4 },
  { id: 'saved_10k', title: 'Five figures', description: 'Have ₹10,000 saved', icon: '🏆', points: 300, test: (c) => c.postedPaise >= 10_000_00 && c.qualifyingPaise >= 10_000_00 },
  { id: 'goal_reached', title: 'Goal getter', description: 'Reach a goal (₹1,000+ target)', icon: '👑', points: 500, test: (c) => c.reachedGoal },
  { id: 'quiz_ace', title: 'Money smart', description: 'Score 5/5 in the Money Quiz', icon: '🧠', points: 100, test: (c) => c.perfectQuiz },
  { id: 'coin_master', title: 'Quick hands', description: 'Score 40+ in Coin Catch', icon: '⚡', points: 100, test: (c) => c.bestCoinScore >= 40 },
];

const QUESTS = [
  { id: 'save_3_times', title: 'Save 3 times', description: `Make 3 savings of ${formatINR(QUALIFYING_CONTRIBUTION_PAISE)} or more this week`, points: 150, unit: 'count' as const, target: 3 },
  { id: 'save_1000', title: 'Grow by ₹1,000', description: 'Grow your savings by ₹1,000 this week (after withdrawals)', points: 200, unit: 'paise' as const, target: 1_000_00 },
  { id: 'play_coin_catch', title: 'Play Coin Catch', description: 'Play one round of Coin Catch', points: 50, unit: 'count' as const, target: 1 },
  { id: 'take_quiz', title: 'Take the Money Quiz', description: 'Finish one Money Quiz', points: 50, unit: 'count' as const, target: 1 },
];

const QUIZ_SESSION_TTL_MS = 30 * 60_000;
const REWARD_LABEL = 'Gullak Rewards (simulated promotional credit)';

/** IST calendar day → UTC ISO instant of its midnight. */
function istMidnightIso(day: ISODate): string {
  return new Date(`${day}T00:00:00+05:30`).toISOString();
}

function weekStartOf(day: ISODate): ISODate {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

export class RewardsService {
  constructor(
    private readonly db: DB,
    private readonly ledger: LedgerService,
    private readonly clock: Clock,
  ) {
    // A reward credit the partner fails or reverses gives the points back.
    ledger.onTransition((txn) => {
      if (txn.origin !== 'reward' || (txn.status !== 'failed' && txn.status !== 'reversed')) return;
      const points = (txn.amount_paise - (txn.amount_paise % PAISE_PER_POINT)) / PAISE_PER_POINT;
      this.award(txn.user_id, 'redemption_refund', txn.id, points, `Points returned: reward credit ${txn.status}`);
    });
  }

  private today(): ISODate {
    return todayInIST(this.clock.now());
  }

  private award(userId: string, source: Source, sourceRef: string, points: number, note: string): boolean {
    if (points === 0) return false;
    const result = run(
      this.db,
      `INSERT OR IGNORE INTO reward_points (user_id, points, source, source_ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      points,
      source,
      sourceRef,
      note,
      nowIso(this.clock),
    );
    return result.changes === 1;
  }

  balance(userId: string): { balance: number; lifetimeEarned: number } {
    const row = one<{ balance: number; earned: number }>(
      this.db,
      `SELECT COALESCE(SUM(points), 0) AS balance,
              COALESCE(SUM(CASE WHEN source IN ('achievement', 'quest', 'quiz', 'game') THEN points ELSE 0 END), 0) AS earned
       FROM reward_points WHERE user_id = ?`,
      userId,
    )!;
    return { balance: row.balance, lifetimeEarned: row.earned };
  }

  /** Completed, non-sample, non-reward savings in a time window. */
  private savingsIn(userId: string, fromIso: string, toIso: string) {
    const row = one<{ count: number; contributed: number; withdrawn: number }>(
      this.db,
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'contribution' AND origin IN ('manual', 'schedule') AND amount_paise >= ?2 THEN 1 ELSE 0 END), 0) AS count,
         COALESCE(SUM(CASE WHEN kind = 'contribution' AND origin IN ('manual', 'schedule') THEN amount_paise ELSE 0 END), 0) AS contributed,
         COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN amount_paise ELSE 0 END), 0) AS withdrawn
       FROM transactions WHERE user_id = ?1 AND status = 'completed' AND created_at >= ?3 AND created_at < ?4`,
      userId,
      QUALIFYING_CONTRIBUTION_PAISE,
      fromIso,
      toIso,
    )!;
    return row;
  }

  /** Consecutive IST weeks (Mon–Sun) with a qualifying saving, counted back from this week. */
  private streak(userId: string): { weeks: number; savedThisWeek: boolean } {
    const rows = all<{ created_at: string }>(
      this.db,
      `SELECT created_at FROM transactions WHERE user_id = ? AND status = 'completed' AND kind = 'contribution'
         AND origin IN ('manual', 'schedule') AND amount_paise >= ? AND created_at >= ?`,
      userId,
      QUALIFYING_CONTRIBUTION_PAISE,
      istMidnightIso(addDays(this.today(), -7 * 104)),
    );
    const weeks = new Set(rows.map((r) => weekStartOf(todayInIST(new Date(r.created_at)))));
    const thisWeek = weekStartOf(this.today());
    const savedThisWeek = weeks.has(thisWeek);
    let cursor = savedThisWeek ? thisWeek : addDays(thisWeek, -7);
    let count = 0;
    while (weeks.has(cursor)) {
      count++;
      cursor = addDays(cursor, -7);
    }
    return { weeks: count, savedThisWeek };
  }

  private context(userId: string, streakWeeks: number): Context {
    const goals = all<{ id: string; target_paise: number; is_example: number }>(
      this.db,
      'SELECT id, target_paise, is_example FROM goals WHERE user_id = ?',
      userId,
    );
    const balances = this.ledger.goalBalances(userId);
    let bestGoalPercent = 0;
    let reachedGoal = false;
    for (const g of goals.filter((g) => g.is_example === 0)) {
      const posted = balances.get(g.id)?.postedPaise ?? 0;
      if (g.target_paise >= 500_00) bestGoalPercent = Math.max(bestGoalPercent, Math.floor((posted * 100) / g.target_paise));
      if (g.target_paise >= 1_000_00 && posted >= g.target_paise) reachedGoal = true;
    }
    const lifetime = this.savingsIn(userId, '0000', '9999');
    const games = one<{ perfect: number; best: number }>(
      this.db,
      `SELECT COALESCE(MAX(CASE WHEN game = 'quiz' AND score = ? THEN 1 ELSE 0 END), 0) AS perfect,
              COALESCE(MAX(CASE WHEN game = 'coin_catch' THEN score ELSE 0 END), 0) AS best
       FROM game_sessions WHERE user_id = ? AND finished_at IS NOT NULL`,
      QUIZ_LENGTH,
      userId,
    )!;
    return {
      personalGoals: goals.filter((g) => g.is_example === 0).length,
      userSchedules: one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM schedules WHERE user_id = ? AND origin = 'user'`, userId)!.n,
      qualifyingCount: lifetime.count,
      qualifyingPaise: lifetime.contributed,
      postedPaise: this.ledger.userTotals(userId).postedPaise,
      bestGoalPercent,
      reachedGoal,
      streakWeeks,
      perfectQuiz: games.perfect === 1,
      bestCoinScore: games.best,
    };
  }

  private quests(userId: string, weekStart: ISODate): QuestDTO[] {
    const from = istMidnightIso(weekStart);
    const to = istMidnightIso(addDays(weekStart, 7));
    const week = this.savingsIn(userId, from, to);
    const net = week.contributed - week.withdrawn;
    const played = (game: string) =>
      one<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM game_sessions WHERE user_id = ? AND game = ? AND finished_at IS NOT NULL AND started_at >= ? AND started_at < ?`,
        userId,
        game,
        from,
        to,
      )!.n;
    const progress: Record<string, number> = {
      // Withdrawing what you saved doesn't count: net savings must cover the deposits.
      save_3_times: net >= 3 * QUALIFYING_CONTRIBUTION_PAISE ? week.count : Math.min(week.count, Math.max(0, Math.floor(net / QUALIFYING_CONTRIBUTION_PAISE))),
      save_1000: Math.max(0, net),
      play_coin_catch: played('coin_catch'),
      take_quiz: played('quiz'),
    };
    const claimed = new Set(
      all<{ source_ref: string }>(
        this.db,
        `SELECT source_ref FROM reward_points WHERE user_id = ? AND source = 'quest' AND source_ref LIKE ?`,
        userId,
        `%:${weekStart}`,
      ).map((r) => r.source_ref.split(':')[0]),
    );
    return QUESTS.map((q) => {
      const p = Math.min(progress[q.id] ?? 0, q.target);
      return {
        id: q.id,
        title: q.title,
        description: q.description,
        points: q.points,
        progress: p,
        target: q.target,
        unit: q.unit,
        status: claimed.has(q.id) ? 'claimed' : p >= q.target ? 'claimable' : 'in_progress',
      };
    });
  }

  /** Full rewards view. Newly earned achievements are awarded here (idempotently). */
  summary(userId: string): RewardsSummaryDTO {
    const streak = this.streak(userId);
    const ctx = this.context(userId, streak.weeks);
    const newlyUnlocked = tx(this.db, () =>
      ACHIEVEMENTS.filter((a) => a.test(ctx) && this.award(userId, 'achievement', a.id, a.points, `Achievement: ${a.title}`)).map((a) => a.id),
    );
    const unlocked = new Map(
      all<{ source_ref: string; created_at: string }>(
        this.db,
        `SELECT source_ref, created_at FROM reward_points WHERE user_id = ? AND source = 'achievement'`,
        userId,
      ).map((r) => [r.source_ref, r.created_at]),
    );
    const today = this.today();
    const weekStart = weekStartOf(today);
    const points = this.balance(userId);
    const coinToday = one<{ plays: number; rewarded: number }>(
      this.db,
      `SELECT COUNT(*) AS plays, COALESCE(SUM(CASE WHEN points_awarded > 0 THEN 1 ELSE 0 END), 0) AS rewarded
       FROM game_sessions WHERE user_id = ? AND game = 'coin_catch' AND day = ? AND finished_at IS NOT NULL`,
      userId,
      today,
    )!;
    const quizToday = one<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM game_sessions WHERE user_id = ? AND game = 'quiz' AND day = ? AND finished_at IS NOT NULL`,
      userId,
      today,
    )!.n;

    return {
      points,
      level: levelFor(points.lifetimeEarned),
      streak,
      weekStart,
      weekEnd: addDays(weekStart, 6),
      quests: this.quests(userId, weekStart),
      achievements: ACHIEVEMENTS.map(
        (a): AchievementDTO => ({
          id: a.id,
          title: a.title,
          description: a.description,
          icon: a.icon,
          points: a.points,
          unlocked: unlocked.has(a.id),
          unlockedAt: unlocked.get(a.id) ?? null,
        }),
      ),
      newlyUnlocked,
      games: {
        quiz: { playedToday: quizToday > 0 },
        coinCatch: {
          playsToday: coinToday.plays,
          rewardedPlaysLeft: Math.max(0, COIN_CATCH.rewardedPlaysPerDay - coinToday.rewarded),
          maxPointsPerGame: COIN_CATCH.maxPointsPerGame,
        },
      },
      redemption: {
        paisePerPoint: PAISE_PER_POINT,
        minPoints: MIN_REDEEM_POINTS,
        stepPoints: REDEEM_STEP_POINTS,
        dailyCapPaise: DAILY_REDEEM_CAP_PAISE,
        redeemedTodayPaise: this.redeemedToday(userId),
      },
      history: all<{ id: number; points: number; source: Source; note: string; created_at: string }>(
        this.db,
        'SELECT id, points, source, note, created_at FROM reward_points WHERE user_id = ? ORDER BY id DESC LIMIT 20',
        userId,
      ).map((r) => ({ id: r.id, points: r.points, source: r.source, note: r.note, createdAt: r.created_at })),
    };
  }

  claimQuest(userId: string, questId: string): RewardsSummaryDTO {
    const quest = QUESTS.find((q) => q.id === questId);
    if (!quest) throw notFound('Quest not found.');
    const weekStart = weekStartOf(this.today());
    tx(this.db, () => {
      const current = this.quests(userId, weekStart).find((q) => q.id === questId)!;
      if (current.status === 'in_progress') throw conflict('quest_incomplete', 'Finish this quest before claiming it.');
      // Unique (user, source, ref) makes double claims a no-op.
      this.award(userId, 'quest', `${questId}:${weekStart}`, quest.points, `Weekly quest: ${quest.title}`);
    });
    return this.summary(userId);
  }

  // -------------------------------------------------------------------------
  // Money Quiz (one rewarded quiz per day; answers stay on the server)
  // -------------------------------------------------------------------------

  startQuiz(userId: string): QuizStartDTO {
    const today = this.today();
    return tx(this.db, () => {
      const done = one(this.db, `SELECT id FROM game_sessions WHERE user_id = ? AND game = 'quiz' AND day = ? AND finished_at IS NOT NULL`, userId, today);
      if (done) throw conflict('quiz_done_today', 'You’ve finished today’s quiz. A new one unlocks tomorrow.');
      const cutoff = new Date(this.clock.now().getTime() - QUIZ_SESSION_TTL_MS).toISOString();
      // Re-opening returns the same questions, so you can't re-roll for easier ones.
      let session = one<{ id: string; payload: string }>(
        this.db,
        `SELECT id, payload FROM game_sessions WHERE user_id = ? AND game = 'quiz' AND day = ? AND finished_at IS NULL AND started_at > ?
         ORDER BY started_at DESC LIMIT 1`,
        userId,
        today,
        cutoff,
      );
      if (!session) {
        const seed = randomInt(2 ** 31 - 1);
        const rand = seededRandom(seed);
        const ids = QUIZ_BANK.map((q) => ({ id: q.id, r: rand() }))
          .sort((a, b) => a.r - b.r)
          .slice(0, QUIZ_LENGTH)
          .map((q) => q.id);
        session = { id: newId('gms'), payload: JSON.stringify({ questionIds: ids }) };
        run(
          this.db,
          `INSERT INTO game_sessions (id, user_id, game, seed, payload, day, started_at) VALUES (?, ?, 'quiz', ?, ?, ?, ?)`,
          session.id,
          userId,
          seed,
          session.payload,
          today,
          nowIso(this.clock),
        );
      }
      const { questionIds } = JSON.parse(session.payload) as { questionIds: string[] };
      return {
        sessionId: session.id,
        questions: questionIds.map((id) => {
          const q = QUIZ_BANK.find((x) => x.id === id)!;
          return { id: q.id, prompt: q.prompt, options: q.options };
        }),
      };
    });
  }

  submitQuiz(userId: string, sessionId: string, answers: number[]): QuizResultDTO {
    return tx(this.db, () => {
      const session = one<{ id: string; payload: string; started_at: string; finished_at: string | null; day: string }>(
        this.db,
        `SELECT id, payload, started_at, finished_at, day FROM game_sessions WHERE id = ? AND user_id = ? AND game = 'quiz'`,
        sessionId,
        userId,
      );
      if (!session) throw notFound('Quiz not found.');
      if (session.finished_at) throw conflict('already_submitted', 'This quiz was already submitted.');
      const elapsed = this.clock.now().getTime() - Date.parse(session.started_at);
      if (elapsed > QUIZ_SESSION_TTL_MS) throw conflict('quiz_expired', 'This quiz expired. Start a new one.');
      const { questionIds } = JSON.parse(session.payload) as { questionIds: string[] };
      if (answers.length !== questionIds.length) throw unprocessable('invalid_answers', 'Answer every question.');

      const results = questionIds.map((id, i) => {
        const q = QUIZ_BANK.find((x) => x.id === id)!;
        const chosen = answers[i]!;
        if (!Number.isInteger(chosen) || chosen < 0 || chosen >= q.options.length) throw unprocessable('invalid_answers', 'Invalid answer.');
        return { id, chosen, answer: q.answer, explanation: q.explanation };
      });
      const correct = results.filter((r) => r.chosen === r.answer).length;
      const points = correct * POINTS_PER_CORRECT + (correct === questionIds.length ? PERFECT_BONUS : 0);
      const updated = run(
        this.db,
        `UPDATE game_sessions SET finished_at = ?, score = ?, points_awarded = ? WHERE id = ? AND finished_at IS NULL`,
        nowIso(this.clock),
        correct,
        points,
        session.id,
      );
      if (updated.changes !== 1) throw conflict('already_submitted', 'This quiz was already submitted.');
      this.award(userId, 'quiz', session.id, points, `Money Quiz: ${correct}/${questionIds.length}`);
      return { correct, total: questionIds.length, pointsAwarded: points, results };
    });
  }

  // -------------------------------------------------------------------------
  // Coin Catch (server-seeded layout; the server recomputes every score)
  // -------------------------------------------------------------------------

  startCoinCatch(userId: string): CoinCatchStartDTO {
    const today = this.today();
    return tx(this.db, () => {
      const started = one<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM game_sessions WHERE user_id = ? AND game = 'coin_catch' AND day = ?`,
        userId,
        today,
      )!.n;
      if (started >= COIN_CATCH.maxSessionsPerDay) throw tooManyRequests('That’s plenty of Coin Catch for today. Come back tomorrow!');
      const rewardedSoFar = this.rewardedCoinPlays(userId, today);
      const id = newId('gms');
      const seed = randomInt(2 ** 31 - 1);
      run(
        this.db,
        `INSERT INTO game_sessions (id, user_id, game, seed, payload, day, started_at) VALUES (?, ?, 'coin_catch', ?, '{}', ?, ?)`,
        id,
        userId,
        seed,
        today,
        nowIso(this.clock),
      );
      return { sessionId: id, seed, durationMs: COIN_CATCH.durationMs, rewarded: rewardedSoFar < COIN_CATCH.rewardedPlaysPerDay };
    });
  }

  private rewardedCoinPlays(userId: string, day: string): number {
    return one<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM game_sessions WHERE user_id = ? AND game = 'coin_catch' AND day = ? AND points_awarded > 0`,
      userId,
      day,
    )!.n;
  }

  finishCoinCatch(userId: string, sessionId: string, caught: number[]): CoinCatchResultDTO {
    return tx(this.db, () => {
      const session = one<{ id: string; seed: number; started_at: string; finished_at: string | null; day: string }>(
        this.db,
        `SELECT id, seed, started_at, finished_at, day FROM game_sessions WHERE id = ? AND user_id = ? AND game = 'coin_catch'`,
        sessionId,
        userId,
      );
      if (!session) throw notFound('Game not found.');
      if (session.finished_at) throw conflict('already_submitted', 'This round was already submitted.');
      const elapsed = this.clock.now().getTime() - Date.parse(session.started_at);
      if (elapsed < COIN_CATCH.durationMs - 1_500) throw unprocessable('round_not_finished', 'The round has not finished yet.');

      const layout = coinCatchLayout(session.seed);
      const unique = new Set(caught);
      const plausible =
        unique.size === caught.length &&
        caught.every((i) => {
          const item = layout[i];
          // An item can only be caught once it has fallen most of the way down.
          return Number.isInteger(i) && item !== undefined && item.spawnMs + item.fallMs * 0.6 <= elapsed + 1_000;
        });
      if (!plausible) throw unprocessable('invalid_result', 'That result could not be verified.');

      const expired = elapsed > COIN_CATCH.durationMs + 10 * 60_000;
      const score = scoreFor(layout, caught);
      const rewarded = !expired && this.rewardedCoinPlays(userId, session.day) < COIN_CATCH.rewardedPlaysPerDay;
      const points = rewarded ? Math.min(score, COIN_CATCH.maxPointsPerGame) : 0;
      run(
        this.db,
        `UPDATE game_sessions SET finished_at = ?, score = ?, points_awarded = ? WHERE id = ? AND finished_at IS NULL`,
        nowIso(this.clock),
        score,
        points,
        session.id,
      );
      this.award(userId, 'game', session.id, points, `Coin Catch: ${score} points`);
      return { score, pointsAwarded: points, rewarded: rewarded && points > 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Redemption: points → simulated reward credit into a goal
  // -------------------------------------------------------------------------

  private redeemedToday(userId: string): number {
    return one<{ total: number }>(
      this.db,
      `SELECT COALESCE(SUM(amount_paise), 0) AS total FROM transactions
       WHERE user_id = ? AND origin = 'reward' AND status <> 'failed' AND created_at >= ?`,
      userId,
      istMidnightIso(this.today()),
    )!.total;
  }

  async redeem(userId: string, goalId: string, points: number, idempotencyKey: string): Promise<CreateTransferResponse> {
    if (!Number.isSafeInteger(points) || points < MIN_REDEEM_POINTS || points % REDEEM_STEP_POINTS !== 0) {
      throw unprocessable('invalid_points', `Redeem at least ${MIN_REDEEM_POINTS} points, in steps of ${REDEEM_STEP_POINTS}.`);
    }
    const amountPaise = pointsToPaise(points);
    return this.ledger.createTransfer({
      userId,
      goalId,
      kind: 'contribution',
      amountPaise,
      idempotencyKey: `reward:${idempotencyKey}`,
      origin: 'reward',
      counterpartyLabel: REWARD_LABEL,
      memo: `Redeemed ${points} Gullak points`,
      // Runs in the same DB transaction as the new instruction: either both happen or neither.
      inTx: (transactionId) => {
        if (this.balance(userId).balance < points) throw unprocessable('insufficient_points', 'You don’t have enough points for that.');
        const already = this.redeemedToday(userId) - amountPaise;
        if (already + amountPaise > DAILY_REDEEM_CAP_PAISE) {
          throw unprocessable('daily_cap', `You can redeem up to ${formatINR(DAILY_REDEEM_CAP_PAISE)} a day (${formatINR(Math.max(0, DAILY_REDEEM_CAP_PAISE - already))} left today).`);
        }
        this.award(userId, 'redemption', transactionId, -points, `Redeemed for ${formatINR(amountPaise)} reward credit (simulated)`);
      },
    });
  }
}
