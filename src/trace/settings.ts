// SPDX-License-Identifier: MIT
/**
 * The `trace` object in `dawn.json`: whether DAWN commands record a trace,
 * whether that trace keeps typed text, and the separate indexing consent.
 *
 *   "trace": { "write": true, "text": true }
 *
 * `write` must be the literal `true` for automatic capture: a project made
 * before capture existed has no `trace` and is never opted in silently.
 * `text` is on unless it is the literal `false`. `index` is permission for a
 * collector, opt-in and separate; DAWN itself sends a trace nowhere.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { durableWrite } from "../fs/durable.ts";

export type TraceSettings = Readonly<{
  /** True only for `"write": true`. */
  write: boolean;
  /** Prompts, notes and feedback text are kept; false keeps metadata only. */
  text: boolean;
  /** Collection and indexing consent: only the literal `true`. */
  index: boolean;
}>;

/** What a new project gets from `dawn init`. */
export const NEW_PROJECT_TRACE = Object.freeze({ write: true, text: true });

/** The project's trace settings from a parsed `dawn.json`; undefined when it has no `trace` object. */
export function traceSettingsOf(manifest: unknown): TraceSettings | undefined {
  if (manifest === null || typeof manifest !== "object") return undefined;
  const trace = (manifest as Record<string, unknown>).trace;
  if (trace === null || typeof trace !== "object" || Array.isArray(trace))
    return undefined;
  const record = trace as Record<string, unknown>;
  return Object.freeze({
    write: record.write === true,
    text: record.text !== false,
    index: record.index === true,
  });
}

/** Problems `dawn check` can report: a value that is read as something else. */
export function traceSettingProblems(manifest: unknown): string[] {
  if (manifest === null || typeof manifest !== "object") return [];
  const trace = (manifest as Record<string, unknown>).trace;
  if (trace === undefined) return [];
  if (trace === null || typeof trace !== "object" || Array.isArray(trace))
    return ['dawn.json "trace" is not an object; it is read as tracing off'];
  const problems: string[] = [];
  for (const key of ["write", "text", "index"] as const) {
    const value = (trace as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean")
      problems.push(
        `dawn.json "trace.${key}" is ${JSON.stringify(value)?.slice(0, 40)}, not true or false; it is read as ${key === "text" ? "on" : "off"}`,
      );
  }
  return problems;
}

/**
 * Read `dawn.json` as an object for a rewrite. Every field is kept as it
 * was; a manifest that is not a JSON object is refused rather than replaced.
 */
async function manifestRecord(
  project: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(project, "dawn.json"), "utf8");
  } catch {
    throw new Error("not a dawn project (no dawn.json here) · dawn init");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("dawn.json is not valid JSON; nothing was changed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("dawn.json is not a JSON object; nothing was changed");
  return value as Record<string, unknown>;
}

/**
 * Turn automatic capture on or off, or text on or off, in `dawn.json`.
 * Other fields, including `trace.index` and unknown trace fields, are kept.
 * Returns whether the file changed.
 */
export async function updateTraceSettings(
  project: string,
  change: Readonly<{ write?: boolean; text?: boolean }>,
): Promise<{ changed: boolean; settings: TraceSettings }> {
  const record = await manifestRecord(project);
  const current =
    record.trace !== null &&
    typeof record.trace === "object" &&
    !Array.isArray(record.trace)
      ? (record.trace as Record<string, unknown>)
      : {};
  const trace: Record<string, unknown> = { ...current };
  if (change.write !== undefined) trace.write = change.write;
  if (change.text !== undefined) trace.text = change.text;
  if (trace.write === true && trace.text === undefined) trace.text = true;
  const next = { ...record, trace };
  const before = JSON.stringify(record);
  const changed = JSON.stringify(next) !== before;
  if (changed)
    await durableWrite(
      join(project, "dawn.json"),
      `${JSON.stringify(next, null, 2)}\n`,
    );
  return { changed, settings: traceSettingsOf(next)! };
}
