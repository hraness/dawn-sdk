// SPDX-License-Identifier: MIT
/**
 * `dawn lint [project|song.ts|score.json] [--album <dir>] [--json]`: the
 * score lint (core/lint): key, harmony, voice leading, vocal register,
 * prosody, density, hook, lyrics, tricks, budgets and album sameness.
 * Deterministic and render-free. Exit 1 on any error finding.
 */
import {
  formatFindings,
  lintAlbum,
  lintSong,
  isLintArchetype,
  RULE_GROUPS,
  type LintFinding,
  type RuleGroup,
  type SongModel,
} from "../../core/lint/index.ts";
import {
  LintInputError,
  loadAlbum,
  loadLintTarget,
  locate,
  type LintTarget,
} from "./load.ts";

export const LINT_USAGE =
  "usage: dawn lint [project|song.ts|score.json] [--album <dir>] [--rules <group,...>] [--archetype <name>] [--all] [--json]";

type Output = { write(text: string): unknown };

const VALUED = new Set(["--album", "--rules", "--archetype"]);

type Parsed =
  | { kind: "help" }
  | { kind: "error"; problem: string }
  | {
      kind: "run";
      target: string;
      album?: string;
      rules?: RuleGroup[];
      archetype?: string;
      all: boolean;
      json: boolean;
    };

export function parseLintArgv(rest: readonly string[]): Parsed {
  if (rest.some((a) => a === "--help" || a === "-h")) return { kind: "help" };
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  let all = false;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--all") all = true;
    else if (VALUED.has(arg)) {
      const value = rest[++i];
      if (value === undefined)
        return { kind: "error", problem: `${arg} needs a value` };
      values[arg] = value;
    } else if (arg.startsWith("-") && arg.length > 1)
      return { kind: "error", problem: `unknown option · ${arg.slice(0, 40)}` };
    else positionals.push(arg);
  }
  if (positionals.length > 1)
    return {
      kind: "error",
      problem: `unexpected argument · ${positionals[1]!.slice(0, 40)}`,
    };
  let rules: RuleGroup[] | undefined;
  if (values["--rules"] !== undefined) {
    rules = values["--rules"].split(",").map((s) => s.trim()) as RuleGroup[];
    const unknown = rules.find(
      (r) => !(RULE_GROUPS as readonly string[]).includes(r),
    );
    if (unknown !== undefined)
      return {
        kind: "error",
        problem: `unknown rule group · ${unknown.slice(0, 40)} (${RULE_GROUPS.join(", ")})`,
      };
  }
  const archetype = values["--archetype"];
  if (archetype !== undefined && !isLintArchetype(archetype))
    return {
      kind: "error",
      problem: `unknown archetype · ${archetype.slice(0, 40)}`,
    };
  return {
    kind: "run",
    target: positionals[0] ?? ".",
    ...(values["--album"] !== undefined ? { album: values["--album"] } : {}),
    ...(rules ? { rules } : {}),
    ...(archetype !== undefined ? { archetype } : {}),
    all,
    json,
  };
}

/** Lints a loaded target; the CLI and `dawn check` share it. */
export function lintTarget(
  target: LintTarget,
  options: Readonly<{ rules?: readonly RuleGroup[]; archetype?: string }> = {},
) {
  const config =
    options.archetype !== undefined
      ? { ...target.config, archetype: options.archetype as never }
      : target.config;
  const report = lintSong(target.score, {
    id: target.id,
    config,
    books: target.books,
    ...(options.rules ? { rules: options.rules } : {}),
  });
  return { ...report, findings: locate(report.findings, target) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runLintCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> {
  const parsed = parseLintArgv(argv.slice(1));
  if (parsed.kind === "help") {
    stdout.write(`${LINT_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    stderr.write(`${parsed.problem} · ${LINT_USAGE}\n`);
    return 2;
  }
  try {
    const target = await loadLintTarget(parsed.target, cwd);
    const report = lintTarget(target, parsed);
    let album: ReturnType<typeof lintAlbum> | undefined;
    if (parsed.album !== undefined) {
      const songs = (await loadAlbum(parsed.album, cwd)).filter(
        (s) => s.id !== target.id,
      );
      const models: SongModel[] = [
        report.model,
        ...songs.map(
          (s) =>
            lintSong(s.score, {
              id: s.id,
              config: s.config,
              books: s.books,
              rules: [],
            }).model,
        ),
      ];
      album = lintAlbum(models, { focus: target.id });
    }
    const errors = report.counts.error + (album?.counts.error ?? 0);
    if (parsed.json) {
      const { model: _model, ...song } = report;
      stdout.write(
        `${JSON.stringify(
          {
            schema: "dawn.lint/v1",
            ok: errors === 0,
            song,
            ...(album
              ? {
                  album: {
                    ok: album.ok,
                    counts: album.counts,
                    findings: album.findings,
                    pairs: album.pairs,
                    classes: Object.fromEntries(
                      album.features.map((f) => [f.id, f.classes]),
                    ),
                  },
                }
              : {}),
          },
          null,
          2,
        )}\n`,
      );
      return errors ? 1 : 0;
    }
    const shown = (fs: readonly LintFinding[]) =>
      parsed.all ? fs : fs.filter((f) => f.severity !== "info");
    for (const line of formatFindings(shown(report.findings)))
      stdout.write(`${line}\n`);
    if (album)
      for (const line of formatFindings(shown(album.findings)))
        stdout.write(`${line}\n`);
    const c = {
      error: errors,
      warn: report.counts.warn + (album?.counts.warn ?? 0),
      info: report.counts.info + (album?.counts.info ?? 0),
    };
    const notes =
      c.info && !parsed.all ? ` (--all shows ${plural(c.info, "note")})` : "";
    stdout.write(
      `${errors ? "lint failed" : "lint ok"} · ${target.id} (${report.archetype}) · ${plural(c.error, "error")}, ${plural(
        c.warn,
        "warning",
      )}, ${plural(c.info, "note")}${album ? ` · album of ${album.features.length}` : ""} · ${report.ms} ms${notes}\n`,
    );
    return errors ? 1 : 0;
  } catch (error) {
    if (
      error instanceof LintInputError ||
      (error instanceof Error && error.message.startsWith("lint: "))
    ) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
