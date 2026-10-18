/**
 * Money Quiz question bank (server-only: answers never reach the client
 * before submission). Plain-language financial literacy and safety.
 */

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

export const QUIZ_BANK: QuizQuestion[] = [
  {
    id: 'otp-share',
    prompt: 'Someone calling from “your bank” asks for the OTP you just received. What should you do?',
    options: ['Share it — they are from the bank', 'Share only the first 3 digits', 'Never share it and hang up', 'Share it if they know your name'],
    answer: 2,
    explanation: 'Banks never ask for your OTP, UPI PIN or password. Anyone asking is trying to take your money.',
  },
  {
    id: 'upi-pin-receive',
    prompt: 'Do you need to enter your UPI PIN to RECEIVE money?',
    options: ['Yes, always', 'No — a PIN is only needed to send or approve a debit', 'Only for amounts above ₹2,000', 'Only on weekends'],
    answer: 1,
    explanation: 'You never need your UPI PIN to receive money. A “collect request” asking for your PIN takes money out.',
  },
  {
    id: 'emergency-size',
    prompt: 'A common guideline for an emergency fund is…',
    options: ['One week of expenses', '3 to 6 months of essential expenses', 'Exactly ₹1 lakh for everyone', 'Whatever is left at month end'],
    answer: 1,
    explanation: 'Many planners suggest 3–6 months of essential expenses, built up gradually.',
  },
  {
    id: 'pay-yourself-first',
    prompt: '“Pay yourself first” means…',
    options: ['Buy something nice on payday', 'Set aside savings as soon as you are paid, before spending', 'Pay your bills last', 'Lend money to yourself'],
    answer: 1,
    explanation: 'Saving first — even a small fixed amount — makes it a habit instead of an afterthought.',
  },
  {
    id: 'inflation',
    prompt: 'If prices rise 6% in a year, ₹100 kept as cash will buy…',
    options: ['More than before', 'The same as before', 'Less than before', 'Exactly double'],
    answer: 2,
    explanation: 'Inflation reduces what money can buy over time.',
  },
  {
    id: 'guaranteed-returns',
    prompt: 'An app promises “guaranteed 5% per month, zero risk”. This is most likely…',
    options: ['A great deal', 'A warning sign of a scam', 'Normal for savings accounts', 'Backed by the government'],
    answer: 1,
    explanation: 'Very high “guaranteed” returns with “zero risk” are classic warning signs.',
  },
  {
    id: 'dicgc',
    prompt: 'Deposit insurance in India (DICGC) covers bank deposits up to…',
    options: ['₹50,000 per account', '₹5 lakh per depositor per bank', 'Unlimited amounts', '₹1 crore per family'],
    answer: 1,
    explanation: 'DICGC covers up to ₹5 lakh per depositor per bank, including interest. It does not cover every product.',
  },
  {
    id: 'budget-50-30-20',
    prompt: 'In the 50/30/20 budgeting idea, the 20% is for…',
    options: ['Eating out', 'Savings and paying off debt', 'Rent', 'Shopping'],
    answer: 1,
    explanation: '50% needs, 30% wants, 20% savings and debt repayment — a simple starting point.',
  },
  {
    id: 'small-daily',
    prompt: 'Saving ₹50 every day for a year adds up to about…',
    options: ['₹1,800', '₹5,000', '₹18,250', '₹50,000'],
    answer: 2,
    explanation: '₹50 × 365 days = ₹18,250. Small amounts add up.',
  },
  {
    id: 'qr-scan',
    prompt: 'A buyer sends you a QR code to “receive” payment for an item you are selling. Scanning it will…',
    options: ['Always add money', 'Possibly take money from you', 'Do nothing', 'Verify your identity'],
    answer: 1,
    explanation: 'Scanning a QR code is used to PAY. Scammers use “scan to receive” tricks.',
  },
  {
    id: 'compound',
    prompt: 'Compound interest means you earn interest on…',
    options: ['Only your original deposit', 'Your deposit plus interest already earned', 'Your loans', 'Nothing'],
    answer: 1,
    explanation: 'Interest earned is added and then earns interest too — that is compounding.',
  },
  {
    id: 'mandate-cancel',
    prompt: 'A recurring UPI AutoPay mandate can be…',
    options: ['Never cancelled', 'Paused or cancelled by you from your UPI app', 'Cancelled only by visiting a branch', 'Cancelled only by the merchant'],
    answer: 1,
    explanation: 'You can manage, pause or revoke AutoPay mandates from your UPI app.',
  },
  {
    id: 'pre-debit',
    prompt: 'Before a recurring e-mandate debit, your bank should send you…',
    options: ['Nothing', 'A pre-debit notification at least 24 hours before', 'A paper letter a month later', 'A new card'],
    answer: 1,
    explanation: 'RBI rules require a pre-debit alert at least 24 hours before recurring debits.',
  },
  {
    id: 'complaint',
    prompt: 'If your bank does not resolve your complaint within 30 days, you can approach…',
    options: ['Social media only', 'The RBI Ombudsman (cms.rbi.org.in)', 'Nobody', 'The police only'],
    answer: 1,
    explanation: 'The RBI Integrated Ombudsman Scheme handles complaints not resolved by the bank.',
  },
  {
    id: 'goal-specific',
    prompt: 'Which goal is easiest to save for?',
    options: ['“Save more someday”', '“₹18,000 for a phone by February”', '“Be rich”', '“Spend less”'],
    answer: 1,
    explanation: 'Specific goals with an amount and date are easier to plan and track.',
  },
  {
    id: 'impulse',
    prompt: 'A simple way to avoid impulse buying is to…',
    options: ['Buy immediately before the price changes', 'Wait 24 hours before non-essential purchases', 'Use more credit', 'Shop when bored'],
    answer: 1,
    explanation: 'A short waiting period helps separate wants from needs.',
  },
  {
    id: 'aadhaar',
    prompt: 'A savings app asks for your Aadhaar OTP to “unlock rewards”. You should…',
    options: ['Share it for the rewards', 'Not share it — it can be misused', 'Share it only once', 'Post it publicly'],
    answer: 1,
    explanation: 'Never share OTPs from other services. Digital Gullak will never ask for them.',
  },
  {
    id: 'digital-gold',
    prompt: 'In Nov 2025, SEBI cautioned that “digital gold” products sold online are…',
    options: ['Regulated securities', 'Outside SEBI’s regulation, with counterparty risks', 'Bank deposits', 'Government bonds'],
    answer: 1,
    explanation: 'SEBI said digital gold is neither a security nor a regulated commodity derivative.',
  },
  {
    id: 'debt-first',
    prompt: 'If you have a credit card balance at 36% a year, a good first step is usually to…',
    options: ['Ignore it', 'Pay it down while keeping a small emergency buffer', 'Take another loan to invest', 'Only pay the minimum forever'],
    answer: 1,
    explanation: 'High-interest debt grows fast; reducing it is often the best “return”.',
  },
  {
    id: 'auto-save',
    prompt: 'Why do automatic savings schedules help many people?',
    options: ['They hide money from you forever', 'They make saving consistent without relying on willpower', 'They guarantee returns', 'They are required by law'],
    answer: 1,
    explanation: 'Consistency beats size — automatic habits make saving easier.',
  },
];

export const QUIZ_LENGTH = 5;
export const POINTS_PER_CORRECT = 10;
export const PERFECT_BONUS = 50;
