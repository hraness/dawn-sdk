// SPDX-License-Identifier: MIT
/**
 * `dawn check` fix-its (DAWN1001) and the `--suggest` hook.
 *
 * A tsc error that names a symbol the SDK change table lists as removed
 * gets the table's hint appended; when the entry is a pure rename it also
 * carries a safe edit that `dawn check --fix` applies at the reported
 * location (only when the token there is the old name).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SDK_CHANGES, type SdkChange } from "../../core/sdk/changes.ts";
import type { Diagnostic } from "../../core/sdk/eval.ts";
import { offsetOf, tokenize } from "../migrate/lex.ts";
import { writeAtomic } from "./init.ts";

export type FixIt = Readonly<{
  file: string;
  line: number;
  col: number;
  from: string;
  to: string;
  /** Pure token rename from the change table. */
  safe: boolean;
}>;

export type CheckDiagnostic = Diagnostic &
  Readonly<{ code?: string; hint?: string; fix?: FixIt }>;

const PATTERNS: readonly RegExp[] = [
  /Module '"dawn(?:\/[\w-]+)?"' has no exported member '([\w$]+)'/,
  /Property '([\w$]+)' does not exist on type '([\w$]+)/,
  /'([\w$]+)' does not exist in type '([\w$]+)/,
];

type RemovedEntry = NonNullable<SdkChange["removed"]>[number] &
  Readonly<{ sdk: string }>;

function findRemoved(
  name: string,
  type: string | undefined,
  changes: readonly SdkChange[],
): RemovedEntry | undefined {
  for (const change of changes)
    for (const entry of change.removed ?? []) {
      const [owner, field] = entry.symbol.includes(".")
        ? entry.symbol.split(".")
        : [undefined, entry.symbol];
      if (field !== name) continue;
      if (
        owner !== undefined &&
        type !== undefined &&
        !type.startsWith(owner) &&
        !owner.startsWith(type)
      )
        continue;
      return { ...entry, sdk: change.sdk };
    }
  return undefined;
}

/** Adds DAWN1001 hints and fix-its to tsc diagnostics. */
export function enrichDiagnostics(
  diagnostics: readonly Diagnostic[],
  changes: readonly SdkChange[] = SDK_CHANGES,
): CheckDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    for (const pattern of PATTERNS) {
      const match = pattern.exec(diagnostic.message);
      if (!match) continue;
      const entry = findRemoved(match[1]!, match[2], changes);
      if (!entry) continue;
      const short = entry.symbol.split(".").pop()!;
      const hint = entry.replacement
        ? `${short} was renamed to ${entry.replacement} (SDK ${entry.sdk})`
        : `${short} was removed in SDK ${entry.sdk}`;
      const via = entry.migration ? `dawn migrate --apply` : undefined;
      const fix =
        entry.replacement &&
        diagnostic.file &&
        diagnostic.line !== undefined &&
        /^[\w$]+$/.test(entry.replacement)
          ? {
              file: diagnostic.file,
              line: diagnostic.line,
              col: diagnostic.col ?? 1,
              from: short,
              to: entry.replacement,
              safe: true,
            }
          : undefined;
      const tail = fix
        ? "fix: dawn check --fix"
        : via
          ? `fix: ${via}`
          : "see dawn changes";
      return {
        ...diagnostic,
        code: "DAWN1001",
        hint,
        message: `${diagnostic.message} · DAWN1001 ${hint} · ${tail}`,
        ...(fix ? { fix } : {}),
      };
    }
    return diagnostic;
  });
}

/**
 * Applies safe fix-its: renames the identifier at each location when it is
 * still the old name. Returns the project-relative files written.
 */
export async function applyFixIts(
  project: string,
  fixes: readonly FixIt[],
): Promise<string[]> {
  const byFile = new Map<string, FixIt[]>();
  for (const fix of fixes)
    if (fix.safe) byFile.set(fix.file, [...(byFile.get(fix.file) ?? []), fix]);
  const wrote: string[] = [];
  for (const [file, list] of byFile) {
    if (
      file.startsWith("..") ||
      file.startsWith("/") ||
      file.startsWith(".dawn/")
    )
      continue;
    let text: string;
    try {
      text = await readFile(join(project, file), "utf8");
    } catch {
      continue;
    }
    const tokens = tokenize(text);
    const edits = new Map<number, { end: number; to: string }>();
    for (const fix of list) {
      const offset = offsetOf(text, fix.line, fix.col);
      // tsc points at the name; for a quoted key it points at the quote.
      const token = tokens.find(
        (t) =>
          t.start === offset || (t.kind === "string" && t.start === offset),
      );
      if (!token) continue;
      if (token.kind === "ident" && token.text === fix.from)
        edits.set(token.start, { end: token.end, to: fix.to });
      else if (token.kind === "string" && token.text.slice(1, -1) === fix.from)
        edits.set(token.start, {
          end: token.end,
          to: `${token.text[0]}${fix.to}${token.text[0]}`,
        });
    }
    if (edits.size === 0) continue;
    let out = "";
    let at = 0;
    for (const [start, { end, to }] of [...edits].sort((a, b) => a[0] - b[0])) {
      out += text.slice(at, start) + to;
      at = end;
    }
    await writeAtomic(join(project, file), out + text.slice(at));
    wrote.push(file);
  }
  return wrote;
}

/** An opportunity hint detector for `dawn check --suggest`, keyed to a change entry. */
export type Suggester = Readonly<{
  id: string;
  sdk: string;
  /** Runs on the evaluated score; returns hint lines (`file:line` when known). */
  run(score: unknown): readonly string[];
}>;

/** Registered detectors. New SDK interfaces add theirs with an `SDK_CHANGES.suggest` id. */
export const SUGGESTERS: readonly Suggester[] = Object.freeze([]);

export function runSuggesters(
  score: unknown,
  suggesters: readonly Suggester[] = SUGGESTERS,
): string[] {
  const out: string[] = [];
  for (const suggester of suggesters)
    try {
      for (const line of suggester.run(score))
        out.push(`hint ${suggester.id} ${line} (SDK ${suggester.sdk})`);
    } catch {
      // a detector never fails the check
    }
  return out;
}
