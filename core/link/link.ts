// SPDX-License-Identifier: MIT
/**
 * A score as a link, and back (docs/design/project-link.md):
 *
 *     <base>#d1.<codec>.<payload>.<digest>
 *
 * `d1` is the envelope version; `<codec>` is `c` (none) or `d` (raw
 * deflate, written only when strictly smaller); `<payload>` is the score
 * bytes after the codec, base64url without padding; `<digest>` is
 * sha256("dawn.score-link/v1\0" || score bytes), base64url, 43 characters.
 *
 * A link is data. Decoding never evaluates anything, never throws, and
 * checks every size before it allocates for it. This side of the code does
 * not import the sound engine; it needs only the score.
 */
import { TrackScore } from "../score.ts";
import {
  DocumentError,
  MAX_SCORE_BYTES,
  decodeScoreBytes,
  encodeScoreBytes,
  revisionBytes,
  type LinkComment,
  type LinkSample,
  type ReadDocument,
  type ScoreDocument,
} from "./document.ts";
import { escapeText } from "./text.ts";

/** Every way decoding (or encoding) a link ends other than with a score. */
export const LINK_ERROR_CODES = [
  "invalid_input",
  "url_too_long",
  "fragment_too_long",
  "missing_fragment",
  "invalid_syntax",
  "unsupported_version",
  "unsupported_codec",
  "invalid_base64url",
  "payload_too_large",
  "decompression_unavailable",
  "decompression_failed",
  "decompressed_too_large",
  "digest_unavailable",
  "digest_mismatch",
  "unsupported_score_version",
  "not_canonical",
  "invalid_score",
] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

/** `message` is already escaped for printing. */
export type LinkFailure = Readonly<{
  ok: false;
  code: LinkErrorCode;
  message: string;
}>;

export type LinkCodec = "c" | "d";

export type DecodedLink = Readonly<{
  ok: true;
  score: TrackScore;
  comments: readonly LinkComment[];
  samples: readonly LinkSample[];
  /**
   * The URL digest, 43 characters: SHA-256 of all the score bytes, comments
   * included. It is the check that the link arrived whole.
   */
  digest: string;
  /**
   * The revision digest, 43 characters: SHA-256 of the score bytes written
   * with no comments (the samples table stays). It names the music, and does
   * not move when someone comments. The same as `digest` in a link with no
   * comments.
   */
  revision: string;
  /** The score version the link was written at; the score here is current. */
  scoreVersion: number;
  codec: LinkCodec;
  /** Length of the score bytes. */
  scoreBytes: number;
  /** Length of the writer's table of field names: which build wrote the link. */
  keys: number;
}>;

export type EncodedLink = Readonly<{
  ok: true;
  /** The base and the fragment together. */
  link: string;
  /** From `#` on. */
  fragment: string;
  /** The URL digest: over all the score bytes. */
  digest: string;
  /** The revision digest: over the score bytes with no comments. */
  revision: string;
  codec: LinkCodec;
  scoreBytes: number;
}>;

export type LinkLimits = Readonly<{
  /** Characters in the whole link. */
  url: number;
  /** Characters after the `#`. */
  fragment: number;
  /** Score bytes, as carried and after decompression. */
  scoreBytes: number;
}>;

export const LINK_LIMITS: LinkLimits = Object.freeze({
  url: 65_536,
  fragment: 32_768,
  scoreBytes: MAX_SCORE_BYTES,
});

type Awaitable<T> = T | Promise<T>;

/**
 * What a link needs from where it runs. A part that is missing gives a
 * typed result (`digest_unavailable`, `decompression_unavailable`), and a
 * link is then written without compression.
 */
export type LinkPlatform = Readonly<{
  sha256?: (bytes: Uint8Array) => Awaitable<Uint8Array>;
  /** Raw deflate. */
  deflate?: (bytes: Uint8Array) => Awaitable<Uint8Array>;
  /** Raw inflate that stops at `max` bytes and returns null past it. */
  inflate?: (bytes: Uint8Array, max: number) => Awaitable<Uint8Array | null>;
}>;

export type LinkOptions = Readonly<{
  limits?: LinkLimits;
  platform?: LinkPlatform;
}>;

const ENVELOPE = "d1";
const DIGEST_DOMAIN = new TextEncoder().encode("dawn.score-link/v1\0");
const DIGEST_CHARACTERS = 43;

function fail(code: LinkErrorCode, message: string): LinkFailure {
  return Object.freeze({ ok: false, code, message: escapeText(message) });
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SEXTET = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) SEXTET[ALPHABET.charCodeAt(i)] = i;

function toBase64url(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    chunk += ALPHABET[a >> 2]!;
    chunk += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) chunk += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) chunk += ALPHABET[c & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** Bytes a base64url text of `characters` would decode to. */
function base64urlLength(characters: number): number {
  return Math.floor((characters * 3) / 4);
}

/** The bytes, or undefined for anything but the one unpadded spelling. */
function fromBase64url(
  text: string,
  start: number,
  end: number,
): Uint8Array | undefined {
  const characters = end - start;
  if (characters % 4 === 1) return undefined;
  const out = new Uint8Array(base64urlLength(characters));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? SEXTET[code]! : -1;
    if (value < 0) return undefined;
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 255;
      held &= (1 << bits) - 1;
    }
  }
  // Bits left over must be zero, or two texts would spell the same bytes.
  return held === 0 ? out : undefined;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

type ByteStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
type StreamMaker = new (format: "deflate-raw") => ByteStream;

/** Runs `bytes` through a stream, stopping once more than `max` came out. */
async function pump(
  stream: ByteStream,
  bytes: Uint8Array,
  max: number,
): Promise<Uint8Array | null> {
  const writer = stream.writable.getWriter();
  // A failure shows on the reading side; this side's copy of it is dropped.
  const written = writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    await written;
  }
  return concat(chunks, total);
}

/**
 * The platform every current browser, Bun and Node share: Web Crypto and
 * Compression Streams. A part the runtime lacks is left out.
 */
export function webPlatform(): LinkPlatform {
  const scope = globalThis as {
    crypto?: { subtle?: SubtleCrypto };
    CompressionStream?: StreamMaker;
    DecompressionStream?: StreamMaker;
  };
  const subtle = scope.crypto?.subtle;
  const Deflate = scope.CompressionStream;
  const Inflate = scope.DecompressionStream;
  return Object.freeze({
    ...(subtle
      ? {
          sha256: async (bytes: Uint8Array) =>
            new Uint8Array(await subtle.digest("SHA-256", bytes.slice())),
        }
      : {}),
    ...(Deflate
      ? {
          deflate: async (bytes: Uint8Array) =>
            (await pump(new Deflate("deflate-raw"), bytes, Infinity))!,
        }
      : {}),
    ...(Inflate
      ? {
          inflate: async (bytes: Uint8Array, max: number) => {
            const out = await pump(new Inflate("deflate-raw"), bytes, max);
            if (out === null) return null;
            // A browser refuses bytes after the end of the stream; Bun reads
            // past them. A stream that still inflates without its last byte
            // ended before that byte, so here it is refused everywhere.
            let ended = true;
            try {
              await pump(
                new Inflate("deflate-raw"),
                bytes.subarray(0, bytes.length - 1),
                max,
              );
            } catch {
              ended = false;
            }
            if (ended) throw new Error("bytes after the compressed score");
            return out;
          },
        }
      : {}),
  });
}

async function digestOf(
  platform: LinkPlatform,
  scoreBytes: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (!platform.sha256) return undefined;
  const input = new Uint8Array(DIGEST_DOMAIN.length + scoreBytes.length);
  input.set(DIGEST_DOMAIN);
  input.set(scoreBytes, DIGEST_DOMAIN.length);
  try {
    const digest = await platform.sha256(input);
    return digest instanceof Uint8Array && digest.length === 32
      ? digest
      : undefined;
  } catch {
    return undefined;
  }
}

/** Compares every byte, whatever the first difference. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

function baseProblem(base: string): string | undefined {
  for (let i = 0; i < base.length; i += 1) {
    const code = base.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x23)
      return "the base of a link has no space, control character or #";
  }
  return undefined;
}

/** The revision digest of score bytes whose URL digest is `whole`. */
async function revisionOf(
  platform: LinkPlatform,
  scoreBytes: Uint8Array,
  whole: Uint8Array,
): Promise<Uint8Array | undefined> {
  const bare = revisionBytes(scoreBytes);
  return bare === scoreBytes ? whole : digestOf(platform, bare);
}

/**
 * Writes `document` as a link after `base` (say `https://example.com/open`;
 * with no base the result is the fragment alone). The same score gives the
 * same score bytes and digest everywhere; the compressed text is whatever
 * this runtime's deflate writes.
 */
export async function encodeLink(
  document: ScoreDocument | TrackScore,
  options: LinkOptions & Readonly<{ base?: string }> = {},
): Promise<EncodedLink | LinkFailure> {
  try {
    const limits = options.limits ?? LINK_LIMITS;
    const platform = options.platform ?? webPlatform();
    const base = options.base ?? "";
    if (typeof base !== "string")
      return fail("invalid_input", "the base of a link is text");
    const problem = baseProblem(base);
    if (problem) return fail("invalid_input", problem);
    const whole: ScoreDocument =
      document instanceof TrackScore ? { score: document } : document;
    if (!(whole?.score instanceof TrackScore))
      return fail("invalid_input", "a link is made from a score");

    let scoreBytes: Uint8Array;
    try {
      scoreBytes = encodeScoreBytes(whole);
    } catch (error) {
      return fail("invalid_score", (error as Error).message);
    }
    if (scoreBytes.length > limits.scoreBytes)
      return fail(
        "payload_too_large",
        `the score is ${scoreBytes.length} bytes; a link holds ${limits.scoreBytes}`,
      );
    const digest = await digestOf(platform, scoreBytes);
    if (!digest) return fail("digest_unavailable", "no SHA-256 here");
    const revision = await revisionOf(platform, scoreBytes, digest);
    if (!revision) return fail("digest_unavailable", "no SHA-256 here");

    let codec: LinkCodec = "c";
    let payload = scoreBytes;
    if (platform.deflate) {
      try {
        const packed = await platform.deflate(scoreBytes);
        if (packed instanceof Uint8Array && packed.length < scoreBytes.length) {
          codec = "d";
          payload = packed;
        }
      } catch {
        // A link without compression is still a link.
      }
    }
    const name = toBase64url(digest);
    const fragment = `#${ENVELOPE}.${codec}.${toBase64url(payload)}.${name}`;
    if (fragment.length - 1 > limits.fragment)
      return fail(
        "fragment_too_long",
        `the link would be ${fragment.length - 1} characters after the #; the bound is ${limits.fragment}`,
      );
    const link = base + fragment;
    if (link.length > limits.url)
      return fail(
        "url_too_long",
        `the link would be ${link.length} characters; the bound is ${limits.url}`,
      );
    return Object.freeze({
      ok: true,
      link,
      fragment,
      digest: name,
      revision: toBase64url(revision),
      codec,
      scoreBytes: scoreBytes.length,
    });
  } catch (error) {
    return fail(
      "invalid_input",
      error instanceof Error ? error.message : "the link could not be written",
    );
  }
}

/**
 * The revision digest of a score of any length: the one `encodeLink` reports,
 * without the link's byte, fragment and URL bounds, so a song too long for a
 * link still has a revision. The comments are left out of the bytes before
 * they are hashed, as `revisionBytes` does. Undefined when the score cannot
 * be written as score bytes or there is no SHA-256 here.
 */
export async function scoreRevision(
  document: ScoreDocument | TrackScore,
  options: Readonly<{ platform?: LinkPlatform }> = {},
): Promise<string | undefined> {
  try {
    const whole: ScoreDocument =
      document instanceof TrackScore ? { score: document } : document;
    if (!(whole?.score instanceof TrackScore)) return undefined;
    const { comments: _comments, ...bare } = whole;
    const digest = await digestOf(
      options.platform ?? webPlatform(),
      encodeScoreBytes(bare),
    );
    return digest ? toBase64url(digest) : undefined;
  } catch {
    return undefined;
  }
}

function allDigits(text: string, from: number): boolean {
  if (from >= text.length) return false;
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

/**
 * Reads a link: a URL with the fragment, or the fragment from `#` on.
 * Returns the score or one of seventeen typed results. Never throws.
 */
export async function decodeLink(
  input: unknown,
  options: LinkOptions = {},
): Promise<DecodedLink | LinkFailure> {
  try {
    return await decode(input, options);
  } catch (error) {
    return fail(
      "invalid_input",
      error instanceof Error ? error.message : "the link could not be read",
    );
  }
}

async function decode(
  input: unknown,
  options: LinkOptions,
): Promise<DecodedLink | LinkFailure> {
  const limits = options.limits ?? LINK_LIMITS;
  const platform = options.platform ?? webPlatform();
  if (typeof input !== "string") return fail("invalid_input", "a link is text");
  if (input.length > limits.url)
    return fail(
      "url_too_long",
      `${input.length} characters; the bound is ${limits.url}`,
    );
  const hash = input.indexOf("#");
  if (hash < 0 || hash === input.length - 1)
    return fail("missing_fragment", "the link has nothing after a #");
  const start = hash + 1;
  if (input.length - start > limits.fragment)
    return fail(
      "fragment_too_long",
      `${input.length - start} characters after the #; the bound is ${limits.fragment}`,
    );

  // d1 . codec . payload . digest
  const dot1 = input.indexOf(".", start);
  const envelope = input.slice(
    start,
    dot1 < 0 ? Math.min(input.length, start + 12) : Math.min(dot1, start + 12),
  );
  if (envelope !== ENVELOPE || dot1 < 0) {
    if (
      dot1 >= 0 &&
      dot1 - start <= 10 &&
      envelope.charCodeAt(0) === 0x64 &&
      allDigits(envelope, 1)
    )
      return fail("unsupported_version", `link version ${envelope}`);
    return fail("invalid_syntax", "not a DAWN link");
  }
  const dot2 = input.indexOf(".", dot1 + 1);
  const dot3 = dot2 < 0 ? -1 : input.indexOf(".", dot2 + 1);
  if (dot3 < 0 || input.indexOf(".", dot3 + 1) >= 0)
    return fail("invalid_syntax", "a link has four parts");
  const codecText = input.slice(dot1 + 1, Math.min(dot2, dot1 + 3));
  if (codecText !== "c" && codecText !== "d") {
    const code = codecText.charCodeAt(0);
    if (dot2 - dot1 === 2 && code >= 0x61 && code <= 0x7a)
      return fail("unsupported_codec", `codec ${codecText}`);
    return fail("invalid_syntax", "a link's codec is one letter");
  }
  const codec: LinkCodec = codecText;
  if (dot3 === dot2 + 1)
    return fail("invalid_syntax", "a link with no payload");
  if (input.length - (dot3 + 1) !== DIGEST_CHARACTERS)
    return fail("invalid_syntax", "a link's digest is 43 characters");
  // Checked on the text's length, before the bytes exist.
  if (base64urlLength(dot3 - (dot2 + 1)) > limits.scoreBytes)
    return fail("payload_too_large", "more payload than a link holds");
  const payload = fromBase64url(input, dot2 + 1, dot3);
  const claimed = fromBase64url(input, dot3 + 1, input.length);
  if (!payload || !claimed || claimed.length !== 32)
    return fail("invalid_base64url", "not base64url without padding");

  let scoreBytes = payload;
  if (codec === "d") {
    if (!platform.inflate)
      return fail("decompression_unavailable", "no inflate here");
    let inflated: Uint8Array | null;
    try {
      inflated = await platform.inflate(payload, limits.scoreBytes);
    } catch {
      return fail("decompression_failed", "the payload does not inflate");
    }
    if (inflated === null)
      return fail(
        "decompressed_too_large",
        `more than ${limits.scoreBytes} bytes after decompression`,
      );
    if (!(inflated instanceof Uint8Array))
      return fail("decompression_failed", "the payload does not inflate");
    if (inflated.length > limits.scoreBytes)
      return fail(
        "decompressed_too_large",
        `more than ${limits.scoreBytes} bytes after decompression`,
      );
    scoreBytes = inflated;
  }

  const digest = await digestOf(platform, scoreBytes);
  if (!digest) return fail("digest_unavailable", "no SHA-256 here");
  if (!sameBytes(digest, claimed))
    return fail("digest_mismatch", "the link was changed or cut short");
  // Deflate is written only when it is smaller, so a compressed payload that
  // is not smaller is a second spelling of a link that has one.
  if (codec === "d" && payload.length >= scoreBytes.length)
    return fail("not_canonical", "compressed without getting smaller");

  let document: ReadDocument;
  try {
    document = decodeScoreBytes(scoreBytes);
  } catch (error) {
    if (error instanceof DocumentError) return fail(error.fault, error.message);
    return fail("invalid_score", "the score did not load");
  }
  const revision = await revisionOf(platform, scoreBytes, digest);
  if (!revision) return fail("digest_unavailable", "no SHA-256 here");
  return Object.freeze({
    ok: true,
    score: document.score,
    comments: document.comments ?? [],
    samples: document.samples ?? [],
    digest: input.slice(dot3 + 1),
    revision: toBase64url(revision),
    scoreVersion: document.version,
    codec,
    scoreBytes: scoreBytes.length,
    keys: document.keys,
  });
}
