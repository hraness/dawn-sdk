// SPDX-License-Identifier: MIT
/**
 * `ProjectFiles` over a directory (read once into memory, bounded) and an
 * overlay that shows a later migration the planned output of earlier ones.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileOp, ProjectFiles } from "./types.ts";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 2000;
const ROOT_FILES = [
  "dawn.json",
  "dawg.json",
  "tsconfig.json",
  ".gitignore",
  "AGENTS.md",
];

function walkTs(root: string, dir: string, out: string[], depth: number): void {
  if (depth > 6 || out.length >= MAX_FILES) return;
  let names: string[];
  try {
    names = readdirSync(join(root, dir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = `${dir}/${name}`;
    let info;
    try {
      info = statSync(join(root, path));
    } catch {
      continue;
    }
    if (info.isDirectory()) walkTs(root, path, out, depth + 1);
    else if (name.endsWith(".ts") && info.size <= MAX_FILE_BYTES)
      out.push(path);
  }
}

/** The editable text files of a project on disk. */
export function diskFiles(root: string): ProjectFiles {
  const paths: string[] = [];
  for (const name of ROOT_FILES)
    try {
      if (statSync(join(root, name)).isFile()) paths.push(name);
    } catch {
      // absent
    }
  try {
    for (const name of readdirSync(root).sort())
      if (name.endsWith(".ts") && statSync(join(root, name)).isFile())
        paths.push(name);
  } catch {
    // unreadable root: nothing to migrate
  }
  walkTs(root, "tracks", paths, 0);
  const cache = new Map<string, string | null>();
  const listed = new Set(paths);
  return Object.freeze({
    list: () => paths,
    read(path: string) {
      if (cache.has(path)) return cache.get(path)!;
      let text: string | null = null;
      try {
        const full = join(root, path);
        if (statSync(full).size <= MAX_FILE_BYTES)
          text = readFileSync(full, "utf8");
      } catch {
        text = null;
      }
      if (listed.has(path) || text !== null) cache.set(path, text);
      return text;
    },
    exists: (path: string) => existsSync(join(root, path)),
    entries(dir: string) {
      try {
        return readdirSync(join(root, dir)).sort();
      } catch {
        return [];
      }
    },
  });
}

/** `base` with `ops` applied in memory. */
export function overlay(
  base: ProjectFiles,
  ops: readonly FileOp[],
): ProjectFiles {
  const written = new Map<string, string>();
  const gone = new Set<string>();
  const moved = new Map<string, string>(); // to → from
  for (const op of ops) {
    if (op.op === "write") {
      written.set(op.path, op.after);
      gone.delete(op.path);
    } else if (op.op === "delete" || op.op === "rmdir") {
      gone.add(op.path);
      written.delete(op.path);
    } else {
      moved.set(op.to, op.from);
      gone.add(op.from);
    }
  }
  const under = (path: string, dir: string) =>
    path === dir || path.startsWith(`${dir}/`);
  const isGone = (path: string) =>
    [...gone].some((dir) => under(path, dir)) && !written.has(path);
  return Object.freeze({
    list() {
      const out = new Set(base.list().filter((path) => !isGone(path)));
      for (const path of written.keys())
        if (!path.startsWith(".")) out.add(path);
      for (const path of written.keys())
        if (
          ["dawn.json", "tsconfig.json", ".gitignore", "AGENTS.md"].includes(
            path,
          )
        )
          out.add(path);
      return [...out];
    },
    read(path: string) {
      if (written.has(path)) return written.get(path)!;
      if (isGone(path)) return null;
      for (const [to, from] of moved)
        if (under(path, to)) return base.read(from + path.slice(to.length));
      return base.read(path);
    },
    exists(path: string) {
      if (written.has(path)) return true;
      for (const to of moved.keys()) if (under(path, to)) return true;
      if ([...written.keys()].some((file) => file.startsWith(`${path}/`)))
        return true;
      if (isGone(path)) return false;
      return base.exists(path);
    },
    entries(dir: string) {
      const names = new Set(isGone(dir) ? [] : base.entries(dir));
      for (const name of [...names])
        if (isGone(`${dir}/${name}`)) names.delete(name);
      for (const path of [...written.keys(), ...moved.keys()])
        if (path.startsWith(`${dir}/`))
          names.add(path.slice(dir.length + 1).split("/")[0]!);
      return [...names].sort();
    },
  });
}
