// SPDX-License-Identifier: MIT
/** The revision digest of a score: its score bytes with no comments. */
import { scoreRevision } from "../../core/link/index.ts";
import type { TrackScore } from "../../core/score.ts";

/**
 * The revision of `score`, as `dawn link` names it; undefined when the
 * score cannot be written as score bytes at all. The length of the link is
 * not a reason: a song too long for a link still has a revision.
 */
export async function revisionOfScore(
  score: TrackScore,
): Promise<string | undefined> {
  return scoreRevision(score);
}
