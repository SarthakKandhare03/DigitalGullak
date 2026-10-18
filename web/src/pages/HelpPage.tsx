import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { DemoNotice, PageHeader } from '../components/ui';

function Faq({ q, children, id }: { q: string; children: ReactNode; id?: string }) {
  return (
    <details id={id}>
      <summary>{q}</summary>
      <div>{children}</div>
    </details>
  );
}

export function HelpPage() {
  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <PageHeader title="Help" description="Plain answers about how Digital Gullak works — and what is different in this demo." />

      <section id="demo" className="stack">
        <DemoNotice>
          <p>
            <strong>Everything here is simulated.</strong> Balances, deposits, withdrawals and schedules are demo records. No funds are held,
            no bank or UPI account is connected, and no money moves. The “partner bank” is a simulation.
          </p>
        </DemoNotice>
      </section>

      <section className="card faq" aria-labelledby="faq-pockets">
        <h2 id="faq-pockets">Goals and pockets</h2>
        <Faq q="How do goal pockets work?">
          <p>
            A pocket is an allocation inside the app: a label that says how much of your savings is set aside for one goal. Pockets are not
            separate bank deposits. Adding savings increases a pocket; withdrawing reduces it.
          </p>
        </Faq>
        <Faq q="Can I rename, edit or archive a goal?">
          <p>
            Yes. You can change the name, icon, target and date at any time. To archive a goal, first withdraw its balance and cancel its
            schedules. Archived goals keep their history and can be restored.
          </p>
        </Faq>
        <Faq q="Why does a transaction say “Pending”?">
          <p>
            Money movements are only final when the bank partner confirms them. Until then we show them as pending and don’t count them in
            your balance. Pending withdrawals are held so the same money can’t be withdrawn twice.
          </p>
        </Faq>
      </section>

      <section className="card faq" aria-labelledby="faq-money">
        <h2 id="faq-money">Your money</h2>
        <Faq q="Where would my real money be held?" id="where">
          <p>
            In the live product, your savings would be held by a regulated bank partner in an account they provide, and the partner’s records
            would decide where the money sits and what legal protection applies. Digital Gullak is not a bank, does not hold customer funds
            itself, and would show the partner’s name and account details before you add any money.
          </p>
          <p>
            <strong>In this demo:</strong> no funds are held anywhere. We don’t make any deposit-insurance claim here; any such wording would
            come from the partner bank, and only if their exact account structure qualifies.
          </p>
        </Faq>
        <Faq q="Are there fees?">
          <p>The demo has no fees. Any fees in a live product would be shown clearly before you confirm anything.</p>
        </Faq>
        <Faq q="Do I earn interest?">
          <p>
            We only show interest when the bank partner provides real terms and actually credits interest to your account. We never estimate or
            promise returns. The demo shows no interest.
          </p>
        </Faq>
        <Faq q="Is my money guaranteed?">
          <p>
            We don’t use words like “zero risk” or “guaranteed”. Protection depends on the partner bank and the account type, which the partner
            would explain in their own terms.
          </p>
        </Faq>
        <Faq q="How do withdrawals work?">
          <p>
            Choose a goal and an amount. Before you confirm, we show the amount and where it goes — in a live product, your verified bank account
            linked with the partner. There are no lock-in periods. In the demo, nothing is sent anywhere.
          </p>
        </Faq>
        <Faq q="How do savings schedules work?">
          <p>
            In the demo, schedules are simulations and never debit anything. A live version would only run through a mandate you approve with
            your bank (such as UPI AutoPay), with the amount, frequency and limits shown up front, a notice at least 24 hours before each debit,
            and the option to pause or cancel at any time.
          </p>
          <p>We never read your SMS, notifications, bank statements or UPI history.</p>
        </Faq>
      </section>

      <section className="card faq" aria-labelledby="faq-account">
        <h2 id="faq-account">Account, privacy and complaints</h2>
        <Faq q="What data do you store?" id="privacy">
          <p>
            For the demo: a scrambled (keyed hash) version of your mobile number and its last four digits, an optional first name, your goals,
            schedules and simulated transactions. No identity documents, bank details or passwords. You can download everything from{' '}
            <Link to="/settings">Account</Link>.
          </p>
          <p>We will never ask for your bank password, UPI PIN, card PIN, Aadhaar number, or an OTP from another app.</p>
        </Faq>
        <Faq q="How do I close my account?">
          <p>
            Withdraw any balance first, then close your account from <Link to="/settings">Account</Link>. Open schedules are cancelled. Transaction
            records are kept (never edited or deleted), and your phone number is removed so it can start afresh. In a live product the partner
            bank would also close your account and keep records for the period the law requires.
          </p>
        </Faq>
        <Faq q="How do I make a complaint?" id="complaints">
          <p>In a live product:</p>
          <ol>
            <li>Contact Digital Gullak support with the transaction reference. We would acknowledge your complaint and share a ticket number.</li>
            <li>If the issue is with the money itself, we would escalate to the partner bank’s grievance officer, whose details would be listed here.</li>
            <li>
              If you don’t get a reply within 30 days, or you aren’t satisfied, you can approach the RBI Ombudsman at{' '}
              <a href="https://cms.rbi.org.in" target="_blank" rel="noreferrer">
                cms.rbi.org.in
              </a>
              .
            </li>
          </ol>
          <p>
            <strong>Demo:</strong> there is no live support desk, because no real money is involved.
          </p>
        </Faq>
      </section>
    </div>
  );
}
