import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { COIN_CATCH, coinCatchLayout, type CoinCatchResultDTO, type CoinCatchStartDTO, type FallingItem } from '../../../shared/rewards';
import { toast } from '../components/Toaster';
import { Notice, PageHeader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { burstConfetti } from '../lib/motion';
import { useRefreshMoney, useRewards } from '../lib/queries';

const W = 360;
const H = 540;
const CATCH_Y = H - 78;
const CATCH_HALF = 0.11; // fraction of width either side of the gullak centre

type Phase = 'intro' | 'countdown' | 'playing' | 'submitting' | 'done';
interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
}

function drawCoin(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const g = ctx.createRadialGradient(x - 4, y - 5, 2, x, y, 15);
  g.addColorStop(0, '#fff7d9');
  g.addColorStop(0.5, '#f0c45a');
  g.addColorStop(1, '#a8751f');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,243,201,.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#6b4710';
  ctx.font = '800 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('₹', x, y + 1);
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const g = ctx.createLinearGradient(x - 18, y - 10, x + 18, y + 10);
  g.addColorStop(0, '#fbe8b2');
  g.addColorStop(0.45, '#e9c06a');
  g.addColorStop(1, '#a8751f');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - 14, y - 9);
  ctx.lineTo(x + 14, y - 9);
  ctx.lineTo(x + 19, y + 9);
  ctx.lineTo(x - 19, y + 9);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = 'rgba(236,198,119,.9)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#5c3d0c';
  ctx.font = '800 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('×3', x, y + 1);
  ctx.shadowBlur = 0;
}

function drawTrap(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.font = '26px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🛍️', x, y);
}

function drawGullak(ctx: CanvasRenderingContext2D, cx: number, glow: number) {
  const y = CATCH_Y + 26;
  ctx.save();
  ctx.shadowColor = `rgba(236,198,119,${0.25 + glow * 0.5})`;
  ctx.shadowBlur = 20 + glow * 20;
  const g = ctx.createLinearGradient(cx - 40, y - 30, cx + 40, y + 30);
  g.addColorStop(0, '#fff0c2');
  g.addColorStop(0.35, '#e8bf68');
  g.addColorStop(0.75, '#b5832f');
  g.addColorStop(1, '#6e4c17');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, y + 6, 40, 30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#b9893a';
  ctx.beginPath();
  ctx.roundRect(cx - 18, y - 30, 36, 10, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(42,26,6,.85)';
  ctx.beginPath();
  ctx.roundRect(cx - 13, y - 14, 26, 5, 2.5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.45)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx - 8, y + 6, 24, Math.PI * 1.05, Math.PI * 1.35);
  ctx.stroke();
}

export function CoinCatchPage() {
  const rewards = useRewards();
  const refresh = useRefreshMoney();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [count, setCount] = useState(3);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number>(COIN_CATCH.durationMs);
  const game = useRef({
    session: null as CoinCatchStartDTO | null,
    layout: [] as FallingItem[],
    resolved: new Set<number>(),
    caught: [] as number[],
    score: 0,
    start: 0,
    x: 0.5,
    target: 0.5,
    keys: { left: false, right: false },
    floaters: [] as Floater[],
    glow: 0,
    frame: 0,
    last: 0,
  });

  const start = useMutation({ mutationFn: () => api<CoinCatchStartDTO>('/api/rewards/coin-catch/start', { method: 'POST' }) });
  const finish = useMutation({
    mutationFn: (input: { sessionId: string; caught: number[] }) =>
      api<CoinCatchResultDTO>(`/api/rewards/coin-catch/${input.sessionId}/finish`, { method: 'POST', body: { caught: input.caught } }),
    onSuccess: (result) => {
      setPhase('done');
      void refresh();
      if (result.pointsAwarded > 0) {
        burstConfetti();
        toast({ icon: '🪙', title: `Coin Catch: ${result.score} points scored`, body: `+${result.pointsAwarded} Gullak points` });
      }
    },
    onError: () => setPhase('done'),
  });

  const draw = useCallback((now: number) => {
    const g = game.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const elapsed = now - g.start;
    const dt = Math.min(50, now - (g.last || now));
    g.last = now;

    // Movement: keyboard nudges the target; the gullak eases toward it.
    if (g.keys.left) g.target = Math.max(0.06, g.target - dt * 0.0011);
    if (g.keys.right) g.target = Math.min(0.94, g.target + dt * 0.0011);
    g.x += (g.target - g.x) * Math.min(1, dt * 0.02);
    g.glow = Math.max(0, g.glow - dt * 0.004);

    ctx.clearRect(0, 0, W, H);
    // Soft "stars"
    ctx.fillStyle = 'rgba(236,198,119,.12)';
    for (let i = 0; i < 18; i++) {
      const sx = ((i * 97) % W) + ((elapsed / 60) % 7);
      const sy = (i * 53 + elapsed / 25) % H;
      ctx.fillRect(sx, sy, 1.5, 1.5);
    }
    // Catch line glow
    const line = ctx.createLinearGradient(0, CATCH_Y, W, CATCH_Y);
    line.addColorStop(0, 'rgba(236,198,119,0)');
    line.addColorStop(0.5, 'rgba(236,198,119,.25)');
    line.addColorStop(1, 'rgba(236,198,119,0)');
    ctx.fillStyle = line;
    ctx.fillRect(0, CATCH_Y + 50, W, 1);

    for (const item of g.layout) {
      if (g.resolved.has(item.index) || item.spawnMs > elapsed) continue;
      const progress = (elapsed - item.spawnMs) / item.fallMs;
      const x = item.x * W;
      const y = progress * CATCH_Y;
      if (progress >= 1) {
        g.resolved.add(item.index);
        if (Math.abs(item.x - g.x) <= CATCH_HALF) {
          g.caught.push(item.index);
          g.score = Math.max(0, g.score + item.value);
          setScore(g.score);
          g.glow = item.value > 0 ? 1 : 0;
          g.floaters.push({
            x,
            y: CATCH_Y - 10,
            text: item.value > 0 ? `+${item.value}` : `${item.value}`,
            color: item.value > 0 ? '#ffe7a3' : '#ff8574',
            born: now,
          });
          navigator.vibrate?.(item.value > 0 ? 12 : [30, 30, 30]);
        }
        continue;
      }
      if (item.kind === 'coin') drawCoin(ctx, x, y);
      else if (item.kind === 'gold') drawBar(ctx, x, y);
      else drawTrap(ctx, x, y);
    }

    drawGullak(ctx, g.x * W, g.glow);

    g.floaters = g.floaters.filter((f) => now - f.born < 800);
    for (const f of g.floaters) {
      const age = (now - f.born) / 800;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = f.color;
      ctx.font = '800 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y - age * 40);
      ctx.globalAlpha = 1;
    }

    setTimeLeft(Math.max(0, COIN_CATCH.durationMs - elapsed));
    if (elapsed >= COIN_CATCH.durationMs) {
      setPhase('submitting');
      finish.mutate({ sessionId: g.session!.sessionId, caught: g.caught });
      return;
    }
    g.frame = requestAnimationFrame(draw);
  }, [finish]);

  // Sharp canvas on high-DPI screens.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.getContext('2d')?.scale(dpr, dpr);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') game.current.keys.left = true;
      if (e.key === 'ArrowRight' || e.key === 'd') game.current.keys.right = true;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && phase === 'playing') e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') game.current.keys.left = false;
      if (e.key === 'ArrowRight' || e.key === 'd') game.current.keys.right = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [phase]);

  useEffect(() => () => cancelAnimationFrame(game.current.frame), []);

  const play = () => {
    setPhase('countdown');
    setCount(3);
    setScore(0);
    finish.reset();
    let n = 3;
    const tick = () => {
      n -= 1;
      if (n > 0) {
        setCount(n);
        window.setTimeout(tick, 700);
        return;
      }
      start.mutate(undefined, {
        onSuccess: (session) => {
          const g = game.current;
          Object.assign(g, {
            session,
            layout: coinCatchLayout(session.seed),
            resolved: new Set<number>(),
            caught: [],
            score: 0,
            floaters: [],
            x: 0.5,
            target: 0.5,
            start: performance.now(),
            last: 0,
          });
          setPhase('playing');
          stageRef.current?.focus();
          g.frame = requestAnimationFrame(draw);
        },
        onError: () => setPhase('intro'),
      });
    };
    window.setTimeout(tick, 700);
  };

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    game.current.target = Math.min(0.94, Math.max(0.06, (e.clientX - rect.left) / rect.width));
  };

  const coin = rewards.data?.games.coinCatch;
  const seconds = Math.ceil(timeLeft / 1000);

  return (
    <div className="stack" style={{ maxWidth: 520, marginInline: 'auto' }}>
      <PageHeader
        title="Coin Catch"
        back={{ to: '/rewards', label: 'Rewards' }}
        description="Move your gullak to catch coins (+1) and gold bars (+3). Dodge impulse buys (−2). Free to play."
      />
      <div
        ref={stageRef}
        className="game-stage"
        tabIndex={0}
        role="application"
        aria-label="Coin Catch game. Use left and right arrow keys, or drag, to move your gullak."
        onPointerMove={onPointer}
        onPointerDown={onPointer}
      >
        <div className="game-timer" aria-hidden="true">
          <div style={{ width: `${(timeLeft / COIN_CATCH.durationMs) * 100}%` }} />
        </div>
        <div className="game-hud" aria-hidden="true">
          <span className="gold-text" style={{ fontSize: '1.5rem' }}>
            {score}
          </span>
          <span className="chip">{phase === 'playing' ? `${seconds}s` : '30s'}</span>
        </div>
        <canvas ref={canvasRef} width={W} height={H} />

        {phase === 'intro' ? (
          <div className="game-overlay">
            <div className="stack" style={{ alignItems: 'center' }}>
              <div style={{ fontSize: '3rem' }} className="float" aria-hidden="true">
                🪙
              </div>
              <h2 style={{ margin: 0 }}>Ready?</h2>
              <p className="small muted" style={{ maxWidth: 260 }}>
                {coin && coin.rewardedPlaysLeft > 0
                  ? `${coin.rewardedPlaysLeft} rewarded play${coin.rewardedPlaysLeft > 1 ? 's' : ''} left today (up to ${coin.maxPointsPerGame} points each).`
                  : 'Practice mode: rewarded plays reset tomorrow.'}
              </p>
              {start.isError ? <Notice tone="error">{errorMessage(start.error)}</Notice> : null}
              <button type="button" className="btn btn--primary btn--lg" onClick={play}>
                Play
              </button>
            </div>
          </div>
        ) : null}
        {phase === 'countdown' ? (
          <div className="game-overlay" aria-live="assertive">
            <span key={count} className="countdown gold-text">
              {count}
            </span>
          </div>
        ) : null}
        {phase === 'submitting' ? (
          <div className="game-overlay" role="status">
            <div className="stack" style={{ alignItems: 'center' }}>
              <span className="spinner" style={{ color: 'var(--gold-2)' }} aria-hidden="true" />
              <span>Verifying your score…</span>
            </div>
          </div>
        ) : null}
        {phase === 'done' ? (
          <div className="game-overlay" role="status">
            <div className="stack" style={{ alignItems: 'center' }}>
              <div style={{ fontSize: '3rem' }} aria-hidden="true">
                {finish.data && finish.data.score >= 30 ? '🏆' : '🪙'}
              </div>
              {finish.isError ? (
                <Notice tone="error">{errorMessage(finish.error)}</Notice>
              ) : (
                <>
                  <h2 style={{ margin: 0 }}>Score: {finish.data?.score ?? score}</h2>
                  <p className="gold-text" style={{ fontWeight: 800, fontSize: '1.3rem', margin: 0 }}>
                    {finish.data?.pointsAwarded ? `+${finish.data.pointsAwarded} Gullak points` : 'Practice round — no points'}
                  </p>
                </>
              )}
              <div className="btn-row" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn btn--primary" onClick={play}>
                  Play again
                </button>
                <Link to="/rewards" className="btn btn--secondary">
                  Rewards
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <p className="tiny muted" style={{ textAlign: 'center' }}>
        Scores are checked by the server against the round’s coin layout. Points have no cash value outside this demo.
      </p>
    </div>
  );
}
