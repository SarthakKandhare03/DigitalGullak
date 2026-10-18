import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MeDTO, PartnerAccountDTO } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ConfirmDialog, Notice, PageHeader, SimChip } from '../components/ui';
import { api, errorMessage, errorReasons } from '../lib/api';
import { keys, useMe } from '../lib/queries';

export function SettingsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const partner = useQuery({ queryKey: ['partner'], queryFn: () => api<PartnerAccountDTO>('/api/partner/account') });
  const closure = useQuery({ queryKey: ['closure'], queryFn: () => api<{ blockers: string[] }>('/api/me/closure') });
  const [name, setName] = useState(me.data?.displayName ?? '');
  const [saved, setSaved] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  const saveName = useMutation({
    mutationFn: () => api<MeDTO>('/api/me', { method: 'PATCH', body: { displayName: name.trim() || null } }),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.me, data);
      setSaved(true);
    },
  });

  const logout = useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.clear();
      navigate('/welcome', { replace: true });
    },
  });

  const close = useMutation({
    mutationFn: () => api('/api/me/close', { method: 'POST', body: { confirm: true } }),
    onSuccess: () => {
      queryClient.clear();
      navigate('/welcome', { replace: true });
    },
  });

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    saveName.mutate();
  };

  const blockers = closure.data?.blockers ?? [];

  return (
    <div className="stack-lg narrow">
      <PageHeader title="Account" />

      <section className="card stack" aria-labelledby="profile-title">
        <h2 id="profile-title">Profile</h2>
        <form className="stack" onSubmit={submitName}>
          <div className="field">
            <label htmlFor="display-name">First name (optional)</label>
            <input id="display-name" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
          </div>
          <div className="row">
            <button type="submit" className="btn btn--secondary btn--small" disabled={saveName.isPending}>
              Save name
            </button>
            <span aria-live="polite" className="small muted">
              {saved ? 'Saved.' : ''}
            </span>
          </div>
          {saveName.isError ? <Notice tone="error">{errorMessage(saveName.error)}</Notice> : null}
        </form>
        <dl className="kv small">
          <dt>Mobile</dt>
          <dd>••••••{me.data?.phoneLast4}</dd>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="partner-title">
        <div className="row-between">
          <h2 id="partner-title" style={{ margin: 0 }}>
            Partner bank account
          </h2>
          <SimChip />
        </div>
        {partner.data ? (
          <dl className="kv small">
            <dt>Partner</dt>
            <dd>{partner.data.partnerDisplayName}</dd>
            <dt>Account</dt>
            <dd>{partner.data.maskedAccountNumber ?? 'Not opened'}</dd>
            <dt>Withdrawals go to</dt>
            <dd>{partner.data.linkedBankAccountLabel ?? '—'}</dd>
            <dt>Status</dt>
            <dd>{partner.data.status}</dd>
            <dt>Interest</dt>
            <dd>{partner.data.interest ? partner.data.interest.annualRateText : 'None shown — no partner terms in the demo'}</dd>
          </dl>
        ) : (
          <p className="muted small">Loading…</p>
        )}
        <p className="tiny muted" style={{ margin: 0 }}>
          A live product would show the real partner bank’s name, your account details and their terms, taken from the partner’s records.
        </p>
      </section>

      <section className="card stack" aria-labelledby="data-title">
        <h2 id="data-title">Your data</h2>
        <p className="small" style={{ margin: 0 }}>
          Download everything this demo stores about you as a JSON file. <Link to="/help#privacy">What we store</Link>
        </p>
        <div>
          <a className="btn btn--secondary btn--small" href="/api/me/export" download>
            <Icon name="download" size={16} /> Download my data
          </a>
        </div>
      </section>

      <section className="card stack" aria-labelledby="more-title">
        <h2 id="more-title">More</h2>
        <ul className="list">
          <li>
            <Link to="/help" className="list-item">
              <Icon name="help" /> <span className="list-item__body">Help and FAQs</span>
            </Link>
          </li>
          <li>
            <Link to="/schedules" className="list-item">
              <Icon name="calendar" /> <span className="list-item__body">Savings schedules</span>
            </Link>
          </li>
          <li>
            <a href="/ops" className="list-item">
              <Icon name="lock" /> <span className="list-item__body">Operator console (demo support staff)</span>
            </a>
          </li>
        </ul>
        <div>
          <button type="button" className="btn btn--ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </section>

      <section className="card card--flat stack" aria-labelledby="close-title">
        <h2 id="close-title">Close demo account</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Your schedules will be cancelled and you’ll be signed out. Records are kept; your mobile number is removed.
        </p>
        {blockers.length ? (
          <Notice tone="warn" title="Not yet">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <div>
          <button type="button" className="btn btn--danger-outline" disabled={blockers.length > 0} onClick={() => setCloseOpen(true)}>
            Close account
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={closeOpen}
        title="Close your demo account?"
        confirmLabel="Close account"
        cancelLabel="Keep account"
        tone="danger"
        busy={close.isPending}
        onCancel={() => setCloseOpen(false)}
        onConfirm={() => close.mutate()}
      >
        <p style={{ margin: 0 }}>This can’t be undone. You can sign up again later with the same number as a new demo user.</p>
        {close.isError ? (
          <Notice tone="error">
            {errorMessage(close.error)}
            {errorReasons(close.error).map((r) => (
              <p key={r}>{r}</p>
            ))}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
