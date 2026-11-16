#!/usr/bin/env -S bun --config=/dev/null --no-env-file --no-install
/** Standalone renderer entry: a score to audio, with no composer. */
import { runRenderSdkCommand } from "./cli.ts";

process.exitCode = await runRenderSdkCommand(
  process.argv.slice(2),
  process.cwd(),
  process.stdout,
  process.stderr,
);
