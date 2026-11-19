#!/usr/bin/env -S bun --config=/dev/null --no-env-file --no-install
// SPDX-License-Identifier: MIT
/**
 * Standalone project tools: make, check, lint, upgrade and share a DAWN
 * project with the MIT sources alone. Each command is the one
 * `dawn <command>` runs, so its messages name it that way. No composer,
 * renderer or account. The lint here reads the SDK's baseline calibration
 * (core/lint/calibration.ts), not the numbers DAWN fits to its own songs.
 */
import { VERSION } from "../version.ts";

type Output = { write(text: string): unknown };
type Command = (
  argv: readonly string[],
  cwd: string,
  out: Output,
  err: Output,
) => Promise<number>;

export const PROJECT_USAGE = `usage: dawn-project <command> [options]

  init [dir]         make a new project
  check              sync, typecheck and evaluate the project here
  lint [target]      key, harmony, prosody, density and album checks
  migrate            upgrade an older project (a dry run until --apply)
  link [song.ts]     the project's score as a link
  open <link> <dir>  a link as a new project folder
  comments           read and write the project's comments

  <command> --help prints its options. Messages name each command as
  DAWN does: \`dawn check\` here is \`dawn-project check\`.`;

const COMMANDS: Readonly<Record<string, () => Promise<Command>>> = {
  init: async () => (await import("./init.ts")).runInitCommand,
  check: async () => {
    // `check --lint`, and a project with a `lint.json`, ask the linter
    // this registers.
    await import("../lint/check-hooks.ts");
    return (await import("./check.ts")).runCheckCommand;
  },
  lint: async () => (await import("../lint/cli.ts")).runLintCommand,
  migrate: async () => (await import("../migrate/cli.ts")).runMigrateCommand,
  link: async () => (await import("../link/cli.ts")).runLinkCommand,
  open: async () => (await import("../link/cli.ts")).runOpenCommand,
  comments: async () => (await import("../comments/cli.ts")).runCommentsCommand,
};

export async function runProjectTool(
  argv: readonly string[],
  cwd: string,
  out: Output,
  err: Output,
): Promise<number> {
  const name = argv[0];
  if (name === undefined || name === "--help" || name === "-h") {
    out.write(`${PROJECT_USAGE}\n`);
    return name === undefined ? 2 : 0;
  }
  if (name === "--version") {
    out.write(`${VERSION}\n`);
    return 0;
  }
  const load = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!load) {
    err.write(`unknown command · ${name.slice(0, 40)}\n${PROJECT_USAGE}\n`);
    return 2;
  }
  return (await load())(argv, cwd, out, err);
}

if (import.meta.main)
  process.exitCode = await runProjectTool(
    process.argv.slice(2),
    process.cwd(),
    process.stdout,
    process.stderr,
  );
