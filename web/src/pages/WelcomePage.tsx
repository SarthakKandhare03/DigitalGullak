import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MeDTO } from '../../../shared/types';
import { DemoBanner } from '../components/AppShell';
import { BrandMark, GullakArt } from '../components/Gullak';
import { Icon } from '../components/Icon';
import { Notice, useDocumentTitle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { keys } from '../lib/queries';

interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  phoneLast4: string;
  demoOtp: string;
  demoNotice: string;
}

export function WelcomePage() {
  useDocumentTitle('Welcome');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);

  const requestOtp = useMutation({
    mutationFn: (value: string) => api<OtpChallenge>('/api/auth/otp/request', { method: 'POST', body: { phone: value } }),
    onSuccess: (data) => {
      setChallenge(data);
      setCode('');
      window.setTimeout(() => document.getElementById('otp')?.focus(), 0);
    },
  });

  const verifyOtp = useMutation({
    mutationFn: () => api<{ user: MeDTO; isNew: boolean }>('/api/auth/otp/verify', { method: 'POST', body: { challengeId: challenge!.challengeId, code } }),
    onSuccess: (data) => {
      queryClient.clear();
      queryClient.setQueryData(keys.me, data.user);
      navigate(data.user.onboarded ? '/' : '/onboarding', { replace: true });
    },
  });

  const submitPhone = (e: FormEvent) => {
    e.preventDefault();
    requestOtp.mutate(phone);
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    verifyOtp.mutate();
  };

  return (
    <>
      <DemoBanner />
      <main className="welcome" id="main">
        <div className="welcome__grid">
          <section className="stack-lg">
            <div className="row">
              <BrandMark size={40} />
              <strong style={{ fontSize: '1.1rem' }}>Digital Gullak</strong>
              <span className="chip chip--sim">Demo</span>
            </div>
            <div className="stack">
              <h1 className="welcome__title" tabIndex={-1} data-page-heading>
                Small savings, <br />
                <span className="gold-text">golden goals.</span>
              </h1>
              <p className="welcome__lead">
                Set aside small amounts in rupees for the things that matter — an emergency fund, rent, a phone, school fees or a trip home.
              </p>
            </div>
            <ul className="feature-list">
              <li>
                <Icon name="target" /> Goal pockets show exactly how much is set aside for each goal, in ₹.
              </li>
              <li>
                <Icon name="shield" /> Built to work with a regulated partner bank. Digital Gullak is not a bank and never holds your money itself.
              </li>
              <li>
                <Icon name="check" /> No lock-ins. Withdraw any time. No gold, stocks or crypto — just rupees.
              </li>
            </ul>
            <GullakArt className="welcome__art" />
          </section>

          <section className="card stack" aria-labelledby="signin-title">
            <h2 id="signin-title">{challenge ? 'Enter your demo code' : 'Try the demo'}</h2>
            <Notice tone="demo" title="This is a demo with simulated money">
              <p>
                No real money moves, no SMS is sent and we don’t ask for identity documents. Use any 10-digit Indian mobile number — we
                store only a scrambled version and its last 4 digits.
              </p>
            </Notice>

            {!challenge ? (
              <form className="stack" onSubmit={submitPhone} noValidate>
                <div className="field">
                  <label htmlFor="phone">Mobile number</label>
                  <div className="input-prefix">
                    <span>+91</span>
                    <input
                      id="phone"
                      className="input"
                      style={{ paddingLeft: 52 }}
                      inputMode="numeric"
                      autoComplete="tel-national"
                      placeholder="98765 43210"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      aria-invalid={requestOtp.isError}
                      aria-describedby={requestOtp.isError ? 'phone-error' : 'phone-hint'}
                    />
                  </div>
                  {requestOtp.isError ? (
                    <span id="phone-error" className="field-error">
                      {errorMessage(requestOtp.error)}
                    </span>
                  ) : (
                    <span id="phone-hint" className="hint">
                      Try 98765 43210 to see a demo account with sample goals.
                    </span>
                  )}
                </div>
                <button className="btn btn--primary btn--block" type="submit" disabled={requestOtp.isPending}>
                  {requestOtp.isPending ? 'Getting code…' : 'Get demo code'}
                </button>
              </form>
            ) : (
              <form className="stack" onSubmit={submitCode} noValidate>
                <div className="otp-demo" aria-live="polite">
                  <div className="tiny" style={{ fontWeight: 700, letterSpacing: '.06em' }}>
                    MOCK OTP · DEMO ONLY
                  </div>
                  <div className="otp-demo__code">{challenge.demoOtp}</div>
                  <div className="small">No SMS was sent. A real app would never show your code on screen.</div>
                </div>
                <div className="field">
                  <label htmlFor="otp">6-digit code for ••••••{challenge.phoneLast4}</label>
                  <input
                    id="otp"
                    className="input otp-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    aria-invalid={verifyOtp.isError}
                    aria-describedby={verifyOtp.isError ? 'otp-error' : undefined}
                  />
                  {verifyOtp.isError ? (
                    <span id="otp-error" className="field-error" role="alert">
                      {errorMessage(verifyOtp.error)}
                    </span>
                  ) : null}
                </div>
                <button className="btn btn--primary btn--block" type="submit" disabled={code.length !== 6 || verifyOtp.isPending}>
                  {verifyOtp.isPending ? 'Signing in…' : 'Sign in'}
                </button>
                <div className="row-between small">
                  <button type="button" className="btn btn--ghost btn--small" onClick={() => setChallenge(null)}>
                    Change number
                  </button>
                  <button type="button" className="btn btn--ghost btn--small" onClick={() => requestOtp.mutate(phone)} disabled={requestOtp.isPending}>
                    Get a new code
                  </button>
                </div>
              </form>
            )}
            <p className="tiny muted" style={{ margin: 0 }}>
              We will never ask for your bank password, UPI PIN, card PIN, Aadhaar number or an OTP from another app. <Link to="/faq">How the demo works</Link>
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
