import { Suspense, useEffect } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '../lib/api';
import { useMe, useRewards } from '../lib/queries';
import { BrandMark } from './Gullak';
import { Icon, type IconName } from './Icon';
import { Toaster } from './Toaster';
import { ErrorState, LoadingBlock } from './ui';

export function DemoBanner() {
  return (
    <div className="demo-banner" role="region" aria-label="Demo notice">
      <div className="demo-banner__inner">
        <span className="demo-pill">DEMO</span>
        <span>
          <strong>Simulated money only.</strong>
          <span className="demo-banner__long"> No real money is held or moved, and balances are not real.</span>
          <span className="demo-banner__short"> Nothing real moves.</span>
        </span>
        <Link to="/help#demo">What this means</Link>
      </div>
    </div>
  );
}

const DESKTOP_NAV: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/', label: 'Home', end: true },
  { to: '/goals', label: 'Goals' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/rewards', label: 'Rewards' },
  { to: '/activity', label: 'Activity' },
  { to: '/help', label: 'Help' },
  { to: '/settings', label: 'Account' },
];

const MOBILE_NAV: Array<{ to: string; label: string; icon: IconName; end?: boolean; center?: boolean }> = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/goals', label: 'Goals', icon: 'target' },
  { to: '/rewards', label: 'Rewards', icon: 'gift', center: true },
  { to: '/activity', label: 'Activity', icon: 'list' },
  { to: '/settings', label: 'Account', icon: 'user' },
];

/** Moves focus to the page heading after navigation so screen-reader and keyboard users land in context. */
function useRouteFocus() {
  const location = useLocation();
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (location.hash) {
        document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      window.scrollTo(0, 0);
      document.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(id);
  }, [location.pathname, location.hash]);
}

/** Warms the code-split chunks of the most-used screens once the browser is idle. */
function usePrefetchRoutes() {
  useEffect(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
    idle(() => {
      void import('../pages/GoalsPage');
      void import('../pages/GoalDetailPage');
      void import('../pages/TransferFlowPage');
      void import('../pages/ActivityPage');
      void import('../pages/RewardsPage');
    });
  }, []);
}

function PointsPill() {
  const rewards = useRewards();
  if (!rewards.data) return null;
  return (
    <Link to="/rewards" className="topbar__points" aria-label={`${rewards.data.points.balance} Gullak points`}>
      <span aria-hidden="true">🪙</span>
      <span className="num">{rewards.data.points.balance.toLocaleString('en-IN')}</span>
    </Link>
  );
}

export function AppShell() {
  const me = useMe();
  const location = useLocation();
  useRouteFocus();
  usePrefetchRoutes();

  if (me.isPending) {
    return (
      <div className="shell">
        <DemoBanner />
        <main className="main">
          <LoadingBlock />
        </main>
      </div>
    );
  }
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/welcome" replace />;
    return (
      <div className="shell">
        <DemoBanner />
        <main className="main">
          <ErrorState error={me.error} onRetry={() => me.refetch()} />
        </main>
      </div>
    );
  }
  if (!me.data.onboarded && location.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <DemoBanner />
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand" aria-label="Digital Gullak home">
            <BrandMark />
            <span>
              Digital <span className="gold-text">Gullak</span>
              <small>Demo · simulated money</small>
            </span>
          </Link>
          <nav className="topnav" aria-label="Main">
            {DESKTOP_NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <PointsPill />
        </div>
      </header>
      <main id="main" className="main">
        <Suspense fallback={<LoadingBlock />}>
          <div key={location.pathname} className="page">
            <Outlet />
          </div>
        </Suspense>
      </main>
      <nav className="bottomnav" aria-label="Main">
        {MOBILE_NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={item.center ? 'bottomnav__center' : undefined}>
            {item.center ? (
              <span className="bubble">
                <Icon name={item.icon} />
              </span>
            ) : (
              <Icon name={item.icon} />
            )}
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Toaster />
    </div>
  );
}
