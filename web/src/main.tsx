import '@fontsource-variable/inter';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { AppShell, DemoBanner } from './components/AppShell';
import { LoadingBlock, PageHeader } from './components/ui';
import { ApiError } from './lib/api';
import { HomePage } from './pages/HomePage';
import { WelcomePage } from './pages/WelcomePage';

// Route-level code splitting: only Home and Welcome ship in the first bundle.
const page = <K extends string>(loader: () => Promise<Record<K, React.ComponentType<never>>>, name: K) =>
  lazy(async () => ({ default: (await loader())[name] as React.ComponentType }));

const ActivityPage = page(() => import('./pages/ActivityPage'), 'ActivityPage');
const CoinCatchPage = page(() => import('./pages/CoinCatchPage'), 'CoinCatchPage');
const GoalDetailPage = page(() => import('./pages/GoalDetailPage'), 'GoalDetailPage');
const GoalFormPage = page(() => import('./pages/GoalFormPage'), 'GoalFormPage');
const GoalsPage = page(() => import('./pages/GoalsPage'), 'GoalsPage');
const HelpPage = page(() => import('./pages/HelpPage'), 'HelpPage');
const NewSchedulePage = page(() => import('./pages/NewSchedulePage'), 'NewSchedulePage');
const OnboardingPage = page(() => import('./pages/OnboardingPage'), 'OnboardingPage');
const OpsPage = page(() => import('./pages/OpsPage'), 'OpsPage');
const QuizPage = page(() => import('./pages/QuizPage'), 'QuizPage');
const RewardsPage = page(() => import('./pages/RewardsPage'), 'RewardsPage');
const SchedulesPage = page(() => import('./pages/SchedulesPage'), 'SchedulesPage');
const SettingsPage = page(() => import('./pages/SettingsPage'), 'SettingsPage');
const TransactionPage = page(() => import('./pages/TransactionPage'), 'TransactionPage');
const TransferPages = () => import('./pages/TransferFlowPage');
const AddSavingsPage = lazy(async () => {
  const m = await TransferPages();
  return { default: () => <m.TransferFlowPage key="add" kind="contribution" /> };
});
const WithdrawPage = lazy(async () => {
  const m = await TransferPages();
  return { default: () => <m.TransferFlowPage key="withdraw" kind="withdrawal" /> };
});
const ChooseAddPage = lazy(async () => {
  const m = await TransferPages();
  return { default: () => <m.ChooseGoalPage kind="contribution" /> };
});
const ChooseWithdrawPage = lazy(async () => {
  const m = await TransferPages();
  return { default: () => <m.ChooseGoalPage kind="withdrawal" /> };
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
    // Never auto-retry mutations: money actions are retried only by the user, with the same idempotency key.
    mutations: { retry: false },
  },
});

function NotFound() {
  return (
    <div className="narrow">
      <PageHeader title="Page not found" />
      <p>
        <Link to="/">Go to home</Link>
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<LoadingBlock />}>
          <Routes>
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/ops" element={<OpsPage />} />
            <Route
              path="/faq"
              element={
                <>
                  <DemoBanner />
                  <main className="main" id="main">
                    <Link to="/welcome" className="back-link">
                      ← Back to sign in
                    </Link>
                    <HelpPage />
                  </main>
                </>
              }
            />
            <Route element={<AppShell />}>
              <Route index element={<HomePage />} />
              <Route path="onboarding" element={<OnboardingPage />} />
              <Route path="goals" element={<GoalsPage />} />
              <Route path="goals/new" element={<GoalFormPage />} />
              <Route path="goals/:goalId" element={<GoalDetailPage />} />
              <Route path="goals/:goalId/edit" element={<GoalFormPage />} />
              <Route path="goals/:goalId/add" element={<AddSavingsPage />} />
              <Route path="goals/:goalId/withdraw" element={<WithdrawPage />} />
              <Route path="add" element={<ChooseAddPage />} />
              <Route path="withdraw" element={<ChooseWithdrawPage />} />
              <Route path="schedules" element={<SchedulesPage />} />
              <Route path="schedules/new" element={<NewSchedulePage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="activity/:transactionId" element={<TransactionPage />} />
              <Route path="rewards" element={<RewardsPage />} />
              <Route path="rewards/quiz" element={<QuizPage />} />
              <Route path="rewards/coin-catch" element={<CoinCatchPage />} />
              <Route path="help" element={<HelpPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
