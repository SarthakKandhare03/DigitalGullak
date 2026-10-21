import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityPageDTO,
  DashboardDTO,
  GoalDTO,
  MeDTO,
  PublicConfigDTO,
  ScheduleDTO,
  TransactionDetailDTO,
} from '../../../shared/types';
import type { RewardsSummaryDTO } from '../../../shared/rewards';
import { api } from './api';

export type GoalDetail = GoalDTO & { archiveBlockers: string[] };

export interface ActivityFilters {
  type?: 'all' | 'contribution' | 'withdrawal' | 'schedule';
  status?: 'pending' | 'completed' | 'failed' | 'reversed';
  goalId?: string;
}

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
  goals: (status: 'active' | 'archived') => ['goals', status] as const,
  goal: (id: string) => ['goal', id] as const,
  transaction: (id: string) => ['transaction', id] as const,
  activity: (filters: ActivityFilters, limit: number) => ['activity', filters, limit] as const,
  schedules: ['schedules'] as const,
};

export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: () => api<PublicConfigDTO>('/api/config'), staleTime: Infinity });

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<MeDTO>('/api/me'), retry: false });

export const useDashboard = () => useQuery({ queryKey: keys.dashboard, queryFn: () => api<DashboardDTO>('/api/dashboard') });

export const useGoals = (status: 'active' | 'archived' = 'active') =>
  useQuery({ queryKey: keys.goals(status), queryFn: () => api<GoalDTO[]>(`/api/goals?status=${status}`) });

export const useGoal = (id: string | undefined) =>
  useQuery({ queryKey: keys.goal(id ?? ''), queryFn: () => api<GoalDetail>(`/api/goals/${id}`), enabled: Boolean(id) });

export const useSchedules = () => useQuery({ queryKey: keys.schedules, queryFn: () => api<ScheduleDTO[]>('/api/schedules') });

/** Polls while the partner has not confirmed yet. */
export const useTransaction = (id: string | undefined) =>
  useQuery({
    queryKey: keys.transaction(id ?? ''),
    queryFn: () => api<TransactionDetailDTO>(`/api/transactions/${id}`),
    enabled: Boolean(id),
    // Back off 1s → 1.5s → 2.25s … capped at 5s, so slow transfers don't hammer the server.
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' ? Math.min(5_000, Math.round(1_000 * 1.5 ** Math.max(0, query.state.dataUpdateCount - 1))) : false,
  });

function activityUrl(filters: ActivityFilters, limit: number, before?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.status) params.set('status', filters.status);
  if (filters.goalId) params.set('goalId', filters.goalId);
  if (before) params.set('before', before);
  return `/api/activity?${params.toString()}`;
}

export const useActivity = (filters: ActivityFilters, limit = 20) =>
  useInfiniteQuery({
    queryKey: keys.activity(filters, limit),
    queryFn: ({ pageParam }) => api<ActivityPageDTO>(activityUrl(filters, limit, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useRewards = () => useQuery({ queryKey: ['rewards'], queryFn: () => api<RewardsSummaryDTO>('/api/rewards') });

/** After any money or goal change, refresh every view that shows balances. */
export function useRefreshMoney() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      ['dashboard', 'goals', 'goal', 'activity', 'schedules', 'rewards', 'insights'].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
}
