// SPDX-License-Identifier: MIT
/**
 * The shape of a `dawn migrate` step. A migration only reads a
 * `ProjectFiles` view and returns edits; the engine (run.ts) prints them as
 * a diff (the default) or applies them with a backup.
 */

export type FileOp =
  /** Create or replace a text file (`before` null: it did not exist). */
  | Readonly<{
      op: "write";
      path: string;
      before: string | null;
      after: string;
    }>
  /** Move a file or directory (state under `.dawg/`, for example). */
  | Readonly<{ op: "rename"; from: string; to: string }>
  /** Remove a file or directory; `before` holds a text file's content, null for a directory. */
  | Readonly<{ op: "delete"; path: string; before: string | null }>
  /** Remove a directory only if it is empty when the step runs. */
  | Readonly<{ op: "rmdir"; path: string }>;

/**
 * Read-only view of a project, paths relative to its root with `/`.
 * `list()` holds the text files migrations may edit: `song.ts`, root
 * `*.ts`, `tracks/**\/*.ts`, `dawn.json`, `dawg.json`, `tsconfig.json`,
 * `.gitignore`, `AGENTS.md`.
 */
export type ProjectFiles = Readonly<{
  list(): readonly string[];
  read(path: string): string | null;
  /** True for any existing path (file or directory). */
  exists(path: string): boolean;
  /** Names directly inside a directory (empty when absent). */
  entries(dir: string): readonly string[];
}>;

/** What the running dawn would write today (SDK, configs, AGENTS block). */
export type MigrationContext = Readonly<{
  dawnVersion: string;
  sdkSource: string;
  sdkTsconfig: string;
  agentsBlock: string;
}>;

export type Migration = Readonly<{
  /** `0001-dawg-to-dawn`; order is the numeric prefix. */
  id: string;
  /** The dawn version that ships it. */
  introducedIn: string;
  title: string;
  /** The edits; never touches disk. Planning its own output must yield []. */
  plan(files: ProjectFiles, context: MigrationContext): readonly FileOp[];
}>;

export const MIGRATION_ID = /^\d{4}-[a-z0-9-]{1,48}$/;
