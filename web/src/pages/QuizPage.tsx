import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { QuizResultDTO, QuizStartDTO } from '../../../shared/rewards';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toaster';
import { LoadingBlock, Notice, PageHeader } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { burstConfetti } from '../lib/motion';
import { useRefreshMoney } from '../lib/queries';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function QuizPage() {
  const refresh = useRefreshMoney();
  const [answers, setAnswers] = useState<number[]>([]);
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const start = useMutation({ mutationFn: () => api<QuizStartDTO>('/api/rewards/quiz/start', { method: 'POST' }) });
  const submit = useMutation({
    mutationFn: (final: number[]) => api<QuizResultDTO>(`/api/rewards/quiz/${start.data!.sessionId}/submit`, { method: 'POST', body: { answers: final } }),
    onSuccess: (result) => {
      void refresh();
      if (result.pointsAwarded > 0) toast({ icon: '🧠', title: `${result.correct}/${result.total} correct`, body: `+${result.pointsAwarded} points` });
      if (result.correct === result.total) burstConfetti();
    },
  });

  useEffect(() => {
    start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, submit.isSuccess]);

  const quiz = start.data;
  const question = quiz?.questions[step];

  const choose = (option: number) => {
    const next = [...answers];
    next[step] = option;
    setAnswers(next);
  };
  const advance = () => {
    if (!quiz) return;
    if (step < quiz.questions.length - 1) setStep(step + 1);
    else submit.mutate(answers);
  };

  return (
    <div className="narrow stack" style={{ marginInline: 'auto' }}>
      <PageHeader title="Money Quiz" back={{ to: '/rewards', label: 'Rewards' }} description="Five quick questions. Free to play, one rewarded quiz a day." />

      {start.isPending ? <LoadingBlock lines={2} /> : null}
      {start.isError ? (
        <Notice tone={start.error instanceof ApiError && start.error.status === 409 ? 'info' : 'error'} title="No quiz right now">
          <p>{errorMessage(start.error)}</p>
          <Link to="/rewards/coin-catch">Try Coin Catch instead</Link>
        </Notice>
      ) : null}

      {quiz && !submit.data ? (
        <section className="card stack" key={step} style={{ animation: 'fadeUp .35s var(--ease) both' }} aria-labelledby="q-title">
          <div className="quiz-progress" aria-hidden="true">
            {quiz.questions.map((q, i) => (
              <span key={q.id} data-on={i <= step} />
            ))}
          </div>
          <p className="tiny muted" style={{ margin: 0 }}>
            Question {step + 1} of {quiz.questions.length}
          </p>
          <h2 id="q-title" ref={headingRef} tabIndex={-1} style={{ fontSize: '1.2rem' }}>
            {question!.prompt}
          </h2>
          <div className="stack" role="group" aria-labelledby="q-title" style={{ gap: 10 }}>
            {question!.options.map((option, i) => (
              <button key={option} type="button" className="quiz-option" aria-pressed={answers[step] === i} onClick={() => choose(i)}>
                <span className="letter" aria-hidden="true">
                  {LETTERS[i]}
                </span>
                {option}
              </button>
            ))}
          </div>
          {submit.isError ? <Notice tone="error">{errorMessage(submit.error)}</Notice> : null}
          <div className="btn-row btn-row--end">
            {step > 0 ? (
              <button type="button" className="btn btn--ghost" onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : null}
            <button type="button" className="btn btn--primary" disabled={answers[step] === undefined || submit.isPending} onClick={advance}>
              {step < quiz.questions.length - 1 ? 'Next' : submit.isPending ? 'Checking…' : 'Submit answers'}
              <Icon name="arrowRight" size={18} />
            </button>
          </div>
        </section>
      ) : null}

      {quiz && submit.data ? (
        <section className="stack" aria-labelledby="result-title">
          <div className="card status-panel">
            <span className={`status-icon ${submit.data.correct >= 3 ? 'status-icon--ok' : 'status-icon--pending'}`}>
              <span style={{ fontSize: '2rem' }} aria-hidden="true">
                {submit.data.correct === submit.data.total ? '🏆' : submit.data.correct >= 3 ? '🎉' : '📚'}
              </span>
            </span>
            <h2 id="result-title" ref={headingRef} tabIndex={-1}>
              {submit.data.correct} of {submit.data.total} correct
            </h2>
            <p className="gold-text" style={{ fontWeight: 800, fontSize: '1.4rem', margin: 0 }}>
              +{submit.data.pointsAwarded} points
            </p>
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <Link to="/rewards" className="btn btn--primary">
                Back to rewards
              </Link>
            </div>
          </div>
          {submit.data.results.map((r, i) => {
            const q = quiz.questions.find((x) => x.id === r.id)!;
            return (
              <div key={r.id} className="card stack" style={{ gap: 8 }}>
                <div className="row-between">
                  <strong>
                    {i + 1}. {q.prompt}
                  </strong>
                  <span className={`badge ${r.chosen === r.answer ? 'badge--completed' : 'badge--failed'}`}>{r.chosen === r.answer ? 'Correct' : 'Not quite'}</span>
                </div>
                <div className={`quiz-option ${r.chosen === r.answer ? 'quiz-option--right' : 'quiz-option--wrong'}`} style={{ cursor: 'default' }}>
                  <span className="letter">{LETTERS[r.chosen]}</span> Your answer: {q.options[r.chosen]}
                </div>
                {r.chosen !== r.answer ? (
                  <div className="quiz-option quiz-option--right" style={{ cursor: 'default' }}>
                    <span className="letter">{LETTERS[r.answer]}</span> Answer: {q.options[r.answer]}
                  </div>
                ) : null}
                <p className="small muted" style={{ margin: 0 }}>
                  {r.explanation}
                </p>
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
