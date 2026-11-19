// SPDX-License-Identifier: MIT
/** Test helpers for migrations: copy a fixture into a temp project. */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Copies `from` to `to`; `_gitignore` becomes `.gitignore` (git would ignore the fixture's own state). */
export function copyFixture(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  if (existsSync(join(to, "_gitignore")))
    renameSync(join(to, "_gitignore"), join(to, ".gitignore"));
}

/** Every file under `root` (relative path → contents), `_gitignore` read as `.gitignore`. */
export function snapshotTree(
  root: string,
  skip: (path: string) => boolean = () => false,
): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      if (skip(path)) continue;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else
        out[path === "_gitignore" ? ".gitignore" : path] = readFileSync(
          join(root, path),
          "utf8",
        );
    }
  };
  walk("");
  return out;
}

export function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
