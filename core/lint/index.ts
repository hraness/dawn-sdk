// SPDX-License-Identifier: MIT
/**
 * `dawn lint`: deterministic score and vocal-book checks that run without
 * a render. `lintSong` reads score JSON plus what the song declares
 * (`LintConfig`) and its vocal books; `lintAlbum` adds the sameness and
 * ledger checks across songs. Thresholds come from the archetype's
 * `LintStyle` (core/lint/style.ts), which a song, a style spec or a caller's
 * own calibration can drive.
 */
import {
  albumRules,
  songFeatures,
  type AlbumPair,
  type SongFeatures,
} from "./album.ts";
import {
  budgetRules,
  densityRules,
  detectTricks,
  sectionDensity,
  trickRules,
} from "./arrangement.ts";
import {
  keyRules,
  lowSecondRules,
  rubRules,
  voiceLeadingRules,
} from "./harmony.ts";
import { allowMatches, songModel, type SongModel } from "./model.ts";
import {
  lintStyle,
  type LintCalibration,
  type LintStyle,
  type Patch,
} from "./style.ts";
import type {
  LintConfig,
  LintFinding,
  RuleGroup,
  Severity,
  VocalBooks,
} from "./types.ts";
import {
  hookRules,
  lyricRules,
  prosodyRules,
  registerRules,
  silenceRules,
} from "./vocal.ts";

export * from "./types.ts";
export {
  lintStyle,
  isLintArchetype,
  LINT_ARCHETYPES,
  type LintStyle,
  type LintArchetype,
  type LintCalibration,
  type LintRange,
  type Patch as LintStylePatch,
} from "./style.ts";
export {
  songModel,
  readBooks,
  readScore,
  keyScale,
  type SongModel,
} from "./model.ts";
export {
  songFeatures,
  tempoBand,
  drumFamily,
  type SongFeatures,
  type AlbumPair,
} from "./album.ts";
export { detectTricks, sectionDensity } from "./arrangement.ts";
export { lintLine, syllables, metric, effective } from "./vocal.ts";

type Rule = (
  m: SongModel,
  style: LintStyle,
  emit: (f: LintFinding) => void,
) => void;

const RULES: readonly (readonly [RuleGroup[], Rule])[] = [
  [["key"], keyRules],
  [["harmony"], rubRules],
  [["harmony"], lowSecondRules],
  [["voice"], voiceLeadingRules],
  [["register"], registerRules],
  [["vocal"], silenceRules],
  [["prosody"], prosodyRules],
  [["density"], densityRules],
  [["hook"], hookRules],
  [["lyrics", "glossary"], lyricRules],
  [["tricks"], trickRules],
  [["budget"], budgetRules],
];

export type LintOptions = Readonly<{
  id?: string;
  config?: LintConfig;
  books?: VocalBooks;
  /** Rule groups to run (default: all). */
  rules?: readonly RuleGroup[];
  /** Threshold overrides on top of the config's. */
  style?: Patch;
  /** The table the thresholds come from (default: core/lint/calibration.ts). */
  calibration?: LintCalibration;
}>;

export type LintReport = Readonly<{
  id: string;
  ok: boolean;
  archetype: string;
  findings: readonly LintFinding[];
  counts: Readonly<Record<Severity, number>>;
  ms: number;
  /** Measured values the thresholds compare against (calibration aid). */
  stats: Readonly<{
    leadTracks: readonly string[];
    sungLines: number;
    harmony: "declared" | "inferred";
    sectionOnsetsPerSec: readonly Readonly<{
      section: string;
      kind: string;
      onsetsPerSec: number;
    }>[];
    tricksDetected: readonly string[];
  }>;
}>;

const counts = (fs: readonly LintFinding[]) => {
  const c = { error: 0, warn: 0, info: 0 };
  for (const f of fs) c[f.severity]++;
  return c;
};

/** Lints one song. Never renders; target < 1 s. */
export function lintSong(
  score: unknown,
  options: LintOptions = {},
): LintReport & { model: SongModel } {
  const started = performance.now();
  const config = options.config ?? {};
  const style = lintStyle(
    config.archetype,
    { ...config.style, ...options.style },
    options.calibration,
  );
  const model = songModel(score, {
    id: options.id ?? "song",
    config,
    ...(options.books ? { books: options.books } : {}),
    centsOk: style.key.centsOk,
    detuneOk: style.key.detuneOk,
  });
  const findings: LintFinding[] = [];
  const want = options.rules ? new Set(options.rules) : undefined;
  // Rule-scoped allow entries without pitch classes or cents silence any
  // finding they match (by track or part, and bars); the pitch-class and
  // cents entries are the key and harmony rules' own business.
  const blanket = (config.allow ?? []).filter(
    (a) => a.rule !== undefined && !a.pcs && a.cents === undefined,
  );
  const allowed = (f: LintFinding) =>
    blanket.some(
      (a) =>
        allowMatches(a, f.rule, f.where.track, f.where.bar) &&
        (a.part === undefined ||
          (f.where.part !== undefined &&
            new RegExp(`^(${a.part})$`).test(f.where.part))),
    );
  for (const [groups, rule] of RULES)
    if (!want || groups.some((g) => want.has(g)))
      rule(model, style, (f) => {
        if (!allowed(f)) findings.push(f);
      });
  const c = counts(findings);
  return {
    id: model.id,
    ok: c.error === 0,
    archetype: style.archetype,
    findings,
    counts: c,
    ms: Math.round(performance.now() - started),
    stats: {
      leadTracks: [...model.lead],
      sungLines: model.lines.length,
      harmony: model.declaredHarmony ? "declared" : "inferred",
      sectionOnsetsPerSec: sectionDensity(model).sections.map((s) => ({
        section: s.section.name,
        kind: s.section.kind,
        onsetsPerSec: Math.round(s.onsetsPerSec * 100) / 100,
      })),
      tricksDetected: detectTricks(model).map(
        (t) => `${t.id}@${t.bars.slice(0, 4).join(",")}`,
      ),
    },
    model,
  };
}

export type AlbumReport = Readonly<{
  ok: boolean;
  findings: readonly LintFinding[];
  counts: Readonly<Record<Severity, number>>;
  pairs: readonly AlbumPair[];
  features: readonly SongFeatures[];
}>;

/**
 * Album checks over linted songs (or their models). With `focus`, only the
 * pairs that include that song id.
 */
export function lintAlbum(
  songs: readonly (SongModel | SongFeatures)[],
  options: Readonly<{
    style?: LintStyle;
    focus?: string;
    calibration?: LintCalibration;
  }> = {},
): AlbumReport {
  const features = songs.map((s) => ("json" in s ? songFeatures(s) : s));
  const findings: LintFinding[] = [];
  const pairs = albumRules(
    features,
    options.style ?? lintStyle(undefined, undefined, options.calibration),
    (f) => findings.push(f),
    options.focus,
  );
  const c = counts(findings);
  return { ok: c.error === 0, findings, counts: c, pairs, features };
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  error: 0,
  warn: 1,
  info: 2,
};

/** Where, as text: `[file:line] [song] [bar:beat] [track]`. */
export function formatWhere(f: LintFinding): string {
  const w = f.where;
  const parts: string[] = [];
  if (w.file) parts.push(`${w.file}${w.line ? `:${w.line}` : ""}`);
  if (w.song) parts.push(w.song);
  if (w.bar !== undefined) parts.push(`${w.bar}:${w.beat ?? 0}`);
  if (w.track && !w.file) parts.push(w.track);
  return parts.join(" ");
}

/**
 * One line per finding group (rule, severity, track and message with its
 * bar numbers folded), at most `limit` lines: `severity rule where message · fix`.
 */
export function formatFindings(
  findings: readonly LintFinding[],
  limit = 40,
): string[] {
  const groups = new Map<string, LintFinding[]>();
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  for (const f of sorted) {
    const k = `${f.severity}|${f.rule}|${f.where.file ?? ""}|${f.where.track ?? ""}|${f.message.replace(/\d+(\.\d+)?/g, "#")}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  const lines: string[] = [];
  for (const list of groups.values()) {
    const f = list[0]!;
    const at = list
      .slice(0, 6)
      .map((x) =>
        x.where.bar !== undefined ? `${x.where.bar}:${x.where.beat ?? 0}` : "",
      )
      .filter(Boolean);
    const more =
      list.length > 1
        ? ` ×${list.length}${at.length ? ` at ${at.join(", ")}${list.length > 6 ? " …" : ""}` : ""}`
        : "";
    const where =
      list.length > 1
        ? [
            f.where.file
              ? `${f.where.file}${f.where.line ? `:${f.where.line}` : ""}`
              : f.where.track,
            f.where.song,
          ]
            .filter(Boolean)
            .join(" ")
        : formatWhere(f);
    lines.push(
      `${f.severity} ${f.rule} ${where ? `${where} ` : ""}${f.message}${more} · ${f.fix}`,
    );
  }
  if (lines.length > limit)
    return [
      ...lines.slice(0, limit),
      `… ${lines.length - limit} more (use --json)`,
    ];
  return lines;
}
