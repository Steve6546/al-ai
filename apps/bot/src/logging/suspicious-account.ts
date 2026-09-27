/**
 * Derived state Discord does not flag itself: an account too new to be trusted.
 *
 * Discord tells a bot when a member joins and nothing about whether the account
 * was made yesterday. That judgement is a signal for a human, not a punishment —
 * the member is left completely untouched and `member.suspicious-account` only
 * puts one line in the member log for an operator to read.
 *
 * The threshold is deliberately a constant rather than a setting: it is a
 * judgement about what "brand new" means, and offering it as a dial invites an
 * operator to set it to zero and silently disarm the check.
 */
export const SUSPICIOUS_ACCOUNT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when the account is younger than the threshold.
 *
 * `now` is passed in rather than read here so a test does not have to mock time,
 * and so the caller's clock is the only clock in the decision.
 */
export function isSuspiciousAccount(createdAt: number, now: number): boolean {
  return now - createdAt < SUSPICIOUS_ACCOUNT_MAX_AGE_MS;
}

/**
 * The reason the operator reads in the log.
 *
 * Says how old the account is in days, rounded up — a four-hour-old account is
 * "اليوم" to a human reading the log, and reporting "0 days" would read as
 * "not new at all".
 */
export function describeSuspiciousAccount(createdAt: number, now: number): string {
  const days = Math.max(1, Math.ceil((now - createdAt) / (24 * 60 * 60 * 1000)));
  return `حساب جديد (عمره أقل من ${days} يوم)`;
}
