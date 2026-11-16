#!/usr/bin/env -S bun --config=/dev/null --no-env-file --no-install
/**
 * The SDK's `dawn-compose`: composes with a composer plug-in in the sealed
 * engine and writes `song.ts` and `tracks/`, which `dawn-render` renders.
 */
import { runComposerSong } from "./cli.ts";

process.exitCode = await runComposerSong(
  ["song", ...process.argv.slice(2)],
  process.cwd(),
  process.stdout,
  process.stderr,
  { command: "dawn-compose" },
);
