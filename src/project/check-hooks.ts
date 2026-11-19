// SPDX-License-Identifier: MIT
/**
 * Advice `dawn check` prints that only another part of DAWN can give. The
 * check itself reads the project, the SDK and the score; it does not import
 * the sound engine. A part that knows more about a track (the engine knows
 * which instrument words play its plain sine) registers a hook here when it
 * loads, and `checkProject` asks every registered hook.
 *
 * A hook is registered once under a name; registering the name again
 * replaces it, so loading a module twice changes nothing.
 *
 * `dawn lint` reaches the check the same way: the check asks whichever
 * linter was registered (src/lint/check-hooks.ts) and has none of its own,
 * so a check that never lints never loads the rules.
 */

import type { Track } from "../../core/score.ts";

/** Warnings for a score's tracks, one line each; they never fail the check. */
export type TrackWarnings = (tracks: readonly Track[]) => readonly string[];

const hooks = new Map<string, TrackWarnings>();

/** Adds (or replaces) the hook called `name`. */
export function registerTrackWarnings(name: string, hook: TrackWarnings): void {
  hooks.set(name, hook);
}

/** Removes the hook called `name`; true when there was one. */
export function unregisterTrackWarnings(name: string): boolean {
  return hooks.delete(name);
}

/** The names registered, in the order they were first added. */
export function trackWarningHooks(): readonly string[] {
  return [...hooks.keys()];
}

/** Every registered hook's warnings for these tracks, in registration order. */
export function trackWarnings(tracks: readonly Track[]): string[] {
  const out: string[] = [];
  for (const hook of hooks.values()) out.push(...hook(tracks));
  return out;
}

/** A linter `dawn check` can ask for findings; they never fail the check. */
export type CheckLinter = Readonly<{
  /** True when the project asks for lint by itself (it has a `lint.json`). */
  configured(project: string): Promise<boolean>;
  /** Findings for the evaluated score, one line each. */
  warnings(project: string, score: unknown): Promise<readonly string[]>;
}>;

let linter: CheckLinter | undefined;

/** Sets (or, with undefined, removes) the linter `dawn check` asks. */
export function registerCheckLinter(next: CheckLinter | undefined): void {
  linter = next;
}

/** The registered linter, when this dawn has one. */
export function checkLinter(): CheckLinter | undefined {
  return linter;
}
