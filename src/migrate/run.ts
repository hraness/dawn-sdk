// SPDX-License-Identifier: MIT
/**
 * The `dawn migrate` engine: plans every pending step over an overlay (so
 * step N sees step N-1's output), records the ledger in dawn.json, prints a
 * diff, and applies with a backup under `.dawn/migrate-backup/<stamp>/`
 * that `undoMigration` restores.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { durableWrite } from "../fs/durable.ts";
import { unifiedDiff } from "./diff.ts";
import { diskFiles, overlay } from "./files.ts";
import { MIGRATIONS } from "./index.ts";
import type {
  FileOp,
  Migration,
  MigrationContext,
  ProjectFiles,
} from "./types.ts";

export const BACKUP_DIR = ".dawn/migrate-backup";
const BACKUP_SCHEMA = "dawn.migrate-backup/v1";

export type MigrationPlan = Readonly<{
  /** Steps with edits, in order. */
  pending: readonly Pick<Migration, "id" | "title" | "introducedIn">[];
  /** Merged edits, ledger included; empty when up to date. */
  ops: readonly FileOp[];
  /** Ids already recorded in dawn.json. */
  applied: readonly string[];
}>;

function ledgerOf(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value = JSON.parse(text) as { migrations?: unknown };
    return Array.isArray(value.migrations)
      ? value.migrations.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** Collapses repeated writes of a path into one (first `before`, last `after`). */
function mergeOps(ops: readonly FileOp[]): FileOp[] {
  const out: FileOp[] = [];
  const writeAt = new Map<string, number>();
  for (const op of ops) {
    if (op.op === "write" && writeAt.has(op.path)) {
      const index = writeAt.get(op.path)!;
      const first = out[index] as Extract<FileOp, { op: "write" }>;
      out[index] = { ...first, after: op.after };
      continue;
    }
    if (op.op === "write") writeAt.set(op.path, out.length);
    out.push(op);
  }
  return out.filter((op) => op.op !== "write" || op.before !== op.after);
}

export function planMigrations(
  files: ProjectFiles,
  context: MigrationContext,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationPlan {
  const applied = ledgerOf(files.read("dawn.json"));
  const pending: Migration[] = [];
  let ops: FileOp[] = [];
  for (const migration of migrations) {
    if (applied.includes(migration.id)) continue;
    const step = migration.plan(overlay(files, ops), context);
    if (step.length === 0) continue;
    pending.push(migration);
    ops = [...ops, ...step];
  }
  if (pending.length === 0)
    return Object.freeze({ pending: [], ops: [], applied });
  const view = overlay(files, ops);
  const manifest = view.read("dawn.json");
  if (manifest !== null) {
    try {
      const record = JSON.parse(manifest) as Record<string, unknown>;
      const ledger = [
        ...new Set([...ledgerOf(manifest), ...pending.map((m) => m.id)]),
      ];
      ops.push({
        op: "write",
        path: "dawn.json",
        before: files.read("dawn.json"),
        after: `${JSON.stringify({ ...record, migrations: ledger }, null, 2)}\n`,
      });
    } catch {
      // an unparsable dawn.json is reported by dawn check; no ledger then
    }
  }
  return Object.freeze({
    pending: pending.map(({ id, title, introducedIn }) => ({
      id,
      title,
      introducedIn,
    })),
    ops: mergeOps(ops),
    applied,
  });
}

function isState(path: string): boolean {
  return path.startsWith(".dawn/") || path.startsWith(".dawg/");
}

/** The dry-run text: unified diffs for project files, one line for state. */
export function renderPlan(plan: MigrationPlan): string {
  const out: string[] = [];
  for (const op of plan.ops) {
    if (op.op === "write") {
      if (isState(op.path))
        out.push(
          `write ${op.path} (${op.after.split("\n").length - 1} lines, dawn state)\n`,
        );
      else out.push(unifiedDiff(op.path, op.before, op.after));
    } else if (op.op === "rename") out.push(`rename ${op.from} → ${op.to}\n`);
    else if (op.op === "delete")
      out.push(
        op.before === null
          ? `delete ${op.path}/\n`
          : unifiedDiff(op.path, op.before, null),
      );
    else out.push(`remove ${op.path}/ if empty\n`);
  }
  return out.join("");
}

/** Project-relative paths an apply would touch (for the git-dirty check). */
export function touchedPaths(plan: MigrationPlan): string[] {
  const paths = new Set<string>();
  for (const op of plan.ops) {
    if (op.op === "rename") {
      paths.add(op.from);
      paths.add(op.to);
    } else paths.add(op.path);
  }
  return [...paths].filter((path) => !isState(path));
}

type BackupEntry =
  | { op: "write"; path: string; existed: boolean }
  | { op: "rename"; from: string; to: string }
  | { op: "delete"; path: string }
  | { op: "rmdir"; path: string; removed: boolean };

export type ApplyResult = Readonly<{
  backup: string;
  applied: readonly string[];
}>;

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Applies a plan with a backup; on failure, undoes what it did. */
export async function applyPlan(
  root: string,
  plan: MigrationPlan,
  now = new Date(),
): Promise<ApplyResult> {
  let name = stamp(now);
  for (let n = 2; existsSync(join(root, BACKUP_DIR, name)); n += 1)
    name = `${stamp(now)}-${n}`;
  const backupRel = `${BACKUP_DIR}/${name}`;
  const backup = join(root, backupRel);
  const saved = join(backup, "files");
  mkdirSync(saved, { recursive: true });
  const entries: BackupEntry[] = [];
  const save = (path: string) => {
    const target = join(saved, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  };
  const writeManifest = (complete: boolean) =>
    durableWrite(
      join(backup, "manifest.json"),
      `${JSON.stringify({ schema: BACKUP_SCHEMA, createdAt: now.toISOString(), complete, migrations: plan.pending.map((m) => m.id), entries }, null, 2)}\n`,
    );
  const order = ["rename", "write", "delete", "rmdir"] as const;
  try {
    for (const kind of order)
      for (const op of plan.ops) {
        if (op.op !== kind) continue;
        if (op.op === "rename") {
          mkdirSync(dirname(join(root, op.to)), { recursive: true });
          renameSync(join(root, op.from), join(root, op.to));
          entries.push({ op: "rename", from: op.from, to: op.to });
        } else if (op.op === "write") {
          const existed = existsSync(join(root, op.path));
          if (existed) save(op.path);
          entries.push({ op: "write", path: op.path, existed });
          await durableWrite(join(root, op.path), op.after);
        } else if (op.op === "delete") {
          if (!existsSync(join(root, op.path))) continue;
          save(op.path);
          entries.push({ op: "delete", path: op.path });
          rmSync(join(root, op.path), { recursive: true, force: true });
        } else {
          let removed = false;
          try {
            rmdirSync(join(root, op.path));
            removed = true;
          } catch {
            // not empty or absent: leave it
          }
          entries.push({ op: "rmdir", path: op.path, removed });
        }
      }
    await writeManifest(true);
  } catch (error) {
    await writeManifest(false).catch(() => undefined);
    restore(root, backup, entries);
    throw error;
  }
  return Object.freeze({
    backup: backupRel,
    applied: plan.pending.map((m) => m.id),
  });
}

function restore(
  root: string,
  backup: string,
  entries: readonly BackupEntry[],
): void {
  const saved = join(backup, "files");
  for (const entry of [...entries].reverse()) {
    if (entry.op === "rename") {
      mkdirSync(dirname(join(root, entry.from)), { recursive: true });
      renameSync(join(root, entry.to), join(root, entry.from));
    } else if (entry.op === "write") {
      rmSync(join(root, entry.path), { force: true });
      if (entry.existed)
        cpSync(join(saved, entry.path), join(root, entry.path));
    } else if (entry.op === "delete") {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      cpSync(join(saved, entry.path), join(root, entry.path), {
        recursive: true,
      });
    } else if (entry.removed)
      mkdirSync(join(root, entry.path), { recursive: true });
  }
}

/** Newest backup directory name, or undefined. */
export function latestBackup(root: string): string | undefined {
  try {
    return readdirSync(join(root, BACKUP_DIR))
      .filter((name) =>
        existsSync(join(root, BACKUP_DIR, name, "manifest.json")),
      )
      .sort()
      .at(-1);
  } catch {
    return undefined;
  }
}

/**
 * Restores the newest backup and removes it. Edits made after the apply to
 * the touched files are lost, so the CLI shows what it will restore first.
 */
export function undoMigration(
  root: string,
): Readonly<{ backup: string; migrations: readonly string[] }> | undefined {
  const name = latestBackup(root);
  if (name === undefined) return undefined;
  const backup = join(root, BACKUP_DIR, name);
  const manifest = JSON.parse(
    readFileSync(join(backup, "manifest.json"), "utf8"),
  ) as {
    schema?: string;
    migrations?: string[];
    entries?: BackupEntry[];
  };
  if (manifest.schema !== BACKUP_SCHEMA || !Array.isArray(manifest.entries))
    throw new Error(
      `${BACKUP_DIR}/${name}/manifest.json is not a dawn migrate backup`,
    );
  restore(root, backup, manifest.entries);
  rmSync(backup, { recursive: true, force: true });
  try {
    if (statSync(join(root, BACKUP_DIR)).isDirectory())
      rmdirSync(join(root, BACKUP_DIR));
  } catch {
    // other backups remain
  }
  return Object.freeze({
    backup: `${BACKUP_DIR}/${name}`,
    migrations: manifest.migrations ?? [],
  });
}

/** Plans `root` on disk. */
export function planProject(
  root: string,
  context: MigrationContext,
): MigrationPlan {
  return planMigrations(diskFiles(root), context);
}
