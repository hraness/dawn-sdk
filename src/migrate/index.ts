// SPDX-License-Identifier: MIT
/** Every `dawn migrate` step, oldest first. Ids are append-only. */

import { migration0001 } from "./0001-dawg-to-dawn.ts";
import { migration0002 } from "./0002-comments-jsonl.ts";
import type { Migration } from "./types.ts";

export const MIGRATIONS: readonly Migration[] = Object.freeze([migration0001]);

export const MIGRATION_IDS: readonly string[] = Object.freeze(
  MIGRATIONS.map((m) => m.id),
);

/**
 * Steps that are written and tested and not yet in force: `dawn check`,
 * `dawn sync` and a plain `dawn migrate` do not know them. One runs when it
 * is named (`dawn migrate --only <id>`), and moves to MIGRATIONS in the
 * release that needs it. 0002 waits for the desktop that reads
 * `comments.jsonl`.
 */
export const HELD_MIGRATIONS: readonly Migration[] = Object.freeze([
  migration0002,
]);
