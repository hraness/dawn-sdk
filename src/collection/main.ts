#!/usr/bin/env -S bun --config=/dev/null --no-env-file --no-install
/** Standalone collection authoring; never evaluates project source. */
import { runCollectionCommand } from "./cli.ts";

process.exitCode = await runCollectionCommand(
  ["collection", ...process.argv.slice(2)],
  process.cwd(),
  process.stdout,
  process.stderr,
);
