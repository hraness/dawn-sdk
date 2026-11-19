// SPDX-License-Identifier: MIT
/**
 * A score as a link. Open side of the seam: nothing here imports the sound
 * engine, the composer, the styles or the presets.
 */
export {
  LINK_ERROR_CODES,
  LINK_LIMITS,
  decodeLink,
  encodeLink,
  scoreRevision,
  webPlatform,
  type DecodedLink,
  type EncodedLink,
  type LinkCodec,
  type LinkErrorCode,
  type LinkFailure,
  type LinkLimits,
  type LinkOptions,
  type LinkPlatform,
} from "./link.ts";
export {
  MAX_SCORE_BYTES,
  FIRST_LINK_KEYS,
  SCORE_BYTES_VERSION,
  decodeScoreBytes,
  encodeScoreBytes,
  revisionBytes,
  withLinkKeys,
  LINK_COMMENT_STATES,
  type LinkComment,
  type LinkCommentState,
  type LinkSample,
  type LinkTarget,
  type ReadDocument,
  type ScoreDocument,
} from "./document.ts";
export { LINK_KEYS } from "./keys.ts";
export { escapeText, findLinks, type FoundLink } from "./text.ts";
