import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { MeDTO } from '../../../shared/types';
import { GullakArt } from '../components/Gullak';
import { Notice, PageHeader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { keys } from '../lib/queries';

export function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onboard = useMutation({
    mutationFn: (choice: 'examples' | 'empty') => api<MeDTO>('/api/me/onboarding', { method: 'POST', body: { choice } }),
    onSuccess: async (me, choice) => {
      queryClient.setQueryData(keys.me, me);
      await queryClient.invalidateQueries();
      navigate(choice === 'empty' ? '/goals/new' : '/', { replace: true });
    },
  });

  return (
    <div className="narrow stack-lg" style={{ marginInline: 'auto' }}>
      <GullakArt className="welcome__art" />
      <PageHeader title="How would you like to start?" description="You can change everything later. Neither option involves real money." />
      <div className="stack">
        <button type="button" className="card goal-card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => onboard.mutate('examples')} disabled={onboard.isPending}>
          <h2>Explore with example goals</h2>
          <p className="muted" style={{ margin: 0 }}>
            We’ll add three sample goals (Emergency fund, New phone, Festival gifts) with simulated history and schedules, clearly marked
            “Sample”.
          </p>
        </button>
        <button type="button" className="card goal-card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => onboard.mutate('empty')} disabled={onboard.isPending}>
          <h2>Start fresh</h2>
          <p className="muted" style={{ margin: 0 }}>
            Begin with no goals and create your first one.
          </p>
        </button>
      </div>
      {onboard.isPending ? <p role="status">Setting up your demo account…</p> : null}
      {onboard.isError ? <Notice tone="error">{errorMessage(onboard.error)}</Notice> : null}
    </div>
  );
}
