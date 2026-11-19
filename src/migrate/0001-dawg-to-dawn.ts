// SPDX-License-Identifier: MIT
/**
 * 0001-dawg-to-dawn: a project from before the rename (dawg.json, `.dawg/`,
 * `from "dawg"`) becomes a dawn project. Edits are token level: strings and
 * comments that merely mention dawg are left alone.
 */

import { minorFloor } from "../update/semver.ts";
import {
  applyEdits,
  type Edit,
  previousSignificant,
  stringValue,
  tokenize,
} from "./lex.ts";
import type {
  FileOp,
  Migration,
  MigrationContext,
  ProjectFiles,
} from "./types.ts";

const OLD_STATE = ".dawg";
const NEW_STATE = ".dawn";
const LEGACY_BEGIN = "<!-- dawg:begin -->";
const LEGACY_END = "<!-- dawg:end -->";

function manifestOps(files: ProjectFiles, context: MigrationContext): FileOp[] {
  const legacy = files.read("dawg.json");
  if (legacy === null) return [];
  const ops: FileOp[] = [];
  if (files.read("dawn.json") === null) {
    let record: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(legacy);
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        record = value as Record<string, unknown>;
    } catch {
      // unreadable: start from the defaults below
    }
    const { format: _format, sdk, dawn: _dawn, ...rest } = record;
    const manifest = {
      format: "dawn.project/v1",
      sdk: typeof sdk === "number" && Number.isInteger(sdk) ? sdk : 1,
      dawn: minorFloor(context.dawnVersion),
      ...rest,
    };
    ops.push({
      op: "write",
      path: "dawn.json",
      before: null,
      after: `${JSON.stringify(manifest, null, 2)}\n`,
    });
  }
  ops.push({ op: "delete", path: "dawg.json", before: legacy });
  return ops;
}

function stateOps(files: ProjectFiles, context: MigrationContext): FileOp[] {
  if (!files.exists(OLD_STATE)) return [];
  const ops: FileOp[] = [];
  for (const name of files.entries(OLD_STATE)) {
    const from = `${OLD_STATE}/${name}`;
    if (name === "sdk") {
      // The vendored SDK is DAWN's to write: replace it with the shipped one.
      if (!files.exists(`${NEW_STATE}/sdk/v1.ts`))
        ops.push({
          op: "write",
          path: `${NEW_STATE}/sdk/v1.ts`,
          before: null,
          after: context.sdkSource,
        });
      if (!files.exists(`${NEW_STATE}/sdk/tsconfig.json`))
        ops.push({
          op: "write",
          path: `${NEW_STATE}/sdk/tsconfig.json`,
          before: null,
          after: context.sdkTsconfig,
        });
      ops.push({ op: "delete", path: from, before: null });
    } else if (name === "tsbuild") {
      ops.push({ op: "delete", path: from, before: null });
    } else if (!files.exists(`${NEW_STATE}/${name}`)) {
      ops.push({ op: "rename", from, to: `${NEW_STATE}/${name}` });
    }
  }
  ops.push({ op: "rmdir", path: OLD_STATE });
  return ops;
}

/** `"./.dawg/x"` → `"./.dawn/x"`, `"dawg"` → `"dawn"`, or undefined. */
function renamedPath(value: string): string | undefined {
  if (value === "dawg") return "dawn";
  if (value.startsWith("dawg/")) return `dawn/${value.slice(5)}`;
  for (const prefix of ["./.dawg/", ".dawg/"])
    if (value.startsWith(prefix)) return value.replace(".dawg/", ".dawn/");
  if (value === ".dawg" || value === "./.dawg")
    return value.replace(".dawg", ".dawn");
  return undefined;
}

function requote(token: string, value: string): string {
  return `${token[0]}${value}${token[token.length - 1]}`;
}

function tsconfigEdits(source: string): Edit[] {
  const edits: Edit[] = [];
  for (const token of tokenize(source)) {
    if (token.kind !== "string") continue;
    const next = renamedPath(stringValue(token));
    if (next !== undefined)
      edits.push({
        start: token.start,
        end: token.end,
        text: requote(token.text, next),
      });
  }
  return edits;
}

const IDENT_RENAMES: Readonly<Record<string, string>> = {
  DawgSdkError: "DawnSdkError",
};

function isSpecifier(
  tokens: ReturnType<typeof tokenize>,
  index: number,
): boolean {
  const prev = previousSignificant(tokens, index);
  if (prev < 0) return false;
  const p = tokens[prev]!;
  if (
    p.kind === "ident" &&
    (p.text === "from" || p.text === "import" || p.text === "module")
  )
    return true;
  if (p.kind === "punct" && p.text === "(") {
    const callee = previousSignificant(tokens, prev);
    return callee >= 0 && ["import", "require"].includes(tokens[callee]!.text);
  }
  return false;
}

function sourceEdits(source: string): Edit[] {
  const tokens = tokenize(source);
  const edits: Edit[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === "ident") {
      const renamed =
        IDENT_RENAMES[token.text] ??
        (/^DAWG_[A-Z0-9_]+$/.test(token.text)
          ? `DAWN_${token.text.slice(5)}`
          : undefined);
      if (renamed !== undefined)
        edits.push({ start: token.start, end: token.end, text: renamed });
      return;
    }
    if (token.kind !== "string") return;
    const value = stringValue(token);
    if (
      isSpecifier(tokens, index) &&
      (value === "dawg" || value.startsWith("dawg/"))
    ) {
      edits.push({
        start: token.start,
        end: token.end,
        text: requote(token.text, renamedPath(value)!),
      });
      return;
    }
    if (/^DAWG_[A-Z0-9_]+$/.test(value)) {
      edits.push({
        start: token.start,
        end: token.end,
        text: requote(token.text, `DAWN_${value.slice(5)}`),
      });
      return;
    }
    if (value.startsWith("./.dawg/") || value.startsWith(".dawg/"))
      edits.push({
        start: token.start,
        end: token.end,
        text: requote(token.text, renamedPath(value)!),
      });
  });
  return edits;
}

function gitignoreAfter(text: string): string {
  const lines = text.split("\n");
  const present = new Set(lines.map((line) => line.trim()));
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = /^(!?)(\/?)\.dawg(\/.*)?$/.exec(trimmed);
    if (!match) {
      out.push(line);
      continue;
    }
    const next = `${match[1]}${match[2]}.dawn${match[3] ?? ""}`;
    if (present.has(next)) continue;
    present.add(next);
    out.push(next);
  }
  return out.join("\n");
}

function agentsAfter(text: string, block: string): string {
  const begin = text.indexOf(LEGACY_BEGIN);
  const end = text.indexOf(LEGACY_END, begin + 1);
  if (begin < 0 || end < 0) return text;
  return (
    text.slice(0, begin) +
    block.replace(/\n$/, "") +
    text.slice(end + LEGACY_END.length)
  );
}

function textOps(files: ProjectFiles, context: MigrationContext): FileOp[] {
  const ops: FileOp[] = [];
  const write = (path: string, before: string, after: string) => {
    if (after !== before) ops.push({ op: "write", path, before, after });
  };
  for (const path of files.list()) {
    const before = files.read(path);
    if (before === null) continue;
    if (path === "tsconfig.json")
      write(path, before, applyEdits(before, tsconfigEdits(before)));
    else if (path === ".gitignore") write(path, before, gitignoreAfter(before));
    else if (path === "AGENTS.md")
      write(path, before, agentsAfter(before, context.agentsBlock));
    else if (path.endsWith(".ts"))
      write(path, before, applyEdits(before, sourceEdits(before)));
  }
  return ops;
}

export const migration0001: Migration = Object.freeze({
  id: "0001-dawg-to-dawn",
  introducedIn: "0.39.0",
  title:
    "dawg project to dawn (dawg.json, .dawg/, imports, tsconfig, AGENTS.md)",
  plan(files: ProjectFiles, context: MigrationContext): readonly FileOp[] {
    return [
      ...manifestOps(files, context),
      ...stateOps(files, context),
      ...textOps(files, context),
    ];
  },
});
