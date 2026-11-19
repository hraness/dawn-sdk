// SPDX-License-Identifier: MIT
/** The small argv contract plain subcommands share (no dependencies). */

export type SimpleArgv =
  | { kind: "help" }
  | { kind: "run"; positionals: readonly string[] }
  | { kind: "error"; problem: string };

/**
 * The contract `dawn init`, `dawn check` and `dawn sessions` share: argv
 * after the subcommand. `--help`/`-h` anywhere asks for usage; any other
 * option, or more than `maxPositionals` words, is an error (exit 2) before
 * the command does anything.
 */
export function parseSimpleArgv(
  rest: readonly string[],
  maxPositionals: number,
): SimpleArgv {
  if (rest.some((arg) => arg === "--help" || arg === "-h"))
    return { kind: "help" };
  const positionals: string[] = [];
  for (const arg of rest) {
    if (arg === "--")
      return { kind: "error", problem: "unexpected argument · --" };
    if (arg.startsWith("-") && arg.length > 1)
      return { kind: "error", problem: `unknown option · ${clip(arg)}` };
    positionals.push(arg);
  }
  if (positionals.length > maxPositionals)
    return {
      kind: "error",
      problem: `unexpected argument · ${clip(positionals[maxPositionals]!)}`,
    };
  return { kind: "run", positionals };
}

function clip(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

export type FlagArgv =
  | { kind: "help" }
  | { kind: "run"; positionals: readonly string[]; flags: ReadonlySet<string> }
  | { kind: "error"; problem: string };

/** `parseSimpleArgv` plus boolean `flags` (e.g. `--json`, `--apply`). */
export function parseFlagArgv(
  rest: readonly string[],
  flags: readonly string[],
  maxPositionals: number,
): FlagArgv {
  const known = new Set(flags);
  const seen = new Set<string>();
  const others: string[] = [];
  for (const arg of rest) {
    if (known.has(arg)) seen.add(arg);
    else others.push(arg);
  }
  const parsed = parseSimpleArgv(others, maxPositionals);
  if (parsed.kind !== "run") return parsed;
  return { kind: "run", positionals: parsed.positionals, flags: seen };
}
