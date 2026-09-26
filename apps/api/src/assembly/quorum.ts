import type { VoteThresholdType } from '@org/shared';

export interface QuorumResult {
  quorumMet: boolean;
  /** Present millimes as ‰ of total, floored (0 for a zero-millime building). */
  presentPermille: number;
}

/**
 * Pure assembly quorum for a vote's meeting, driven by ATTENDANCE (present +
 * proxy units), not by cast ballots.
 *
 * Mirrors the thresholds modeled on the Vote model (`thresholdType String`,
 * see votes/tally-vote.ts):
 * - SIMPLE_MAJORITY / HEADCOUNT → quorum at half of the building's total
 *   weight (inclusive: present * 2 >= total). For HEADCOUNT the caller passes
 *   unit counts so quorum is a pure headcount.
 * - MILLIMES_MAJORITY → the same inclusive 50% line as the ballot tally
 *   (present * 2 >= total), so the live meter and final result never disagree
 *   at the boundary.
 *
 * A zero-millime building is degenerate and always reports quorum met,
 * matching tallyVote's behaviour for the same edge case.
 */
export function quorumOf(
  totalMillimes: number,
  presentMillimes: number,
  _thresholdType: VoteThresholdType,
): QuorumResult {
  void _thresholdType;
  const total = Math.max(0, Math.trunc(totalMillimes));
  const present = Math.min(Math.max(0, Math.trunc(presentMillimes)), total);

  const presentPermille =
    total > 0 ? Math.floor((present * 1000) / total) : 0;

  const quorumMet = total === 0 ? true : present * 2 >= total;

  return { quorumMet, presentPermille };
}
