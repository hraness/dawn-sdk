/**
 * What an installed or built collection file may be. Installed entries are
 * data: names that other tools would load as configuration or code (dot
 * files, package manifests, Bun's config) are refused, Git LFS pointers are
 * reported instead of being treated as content, and archives are refused
 * rather than extracted.
 */

/** Budgets for one install, update or build. */
export const TRANSFER_LIMITS = Object.freeze({
  /** Total bytes one command may download or copy. */
  totalBytes: 4 * 1024 ** 3,
  /** One file without a declared size. */
  undeclaredBytes: 1024 ** 3,
  catalogBytes: 8 * 1024 * 1024,
  /** Waiting for a response's headers or its next chunk. */
  idleMs: 30_000,
  /** The whole command. */
  totalMs: 15 * 60_000,
  redirects: 5,
  /** Remote refs resolved by one command. */
  resolutions: 64,
});

const FORBIDDEN_NAMES = new Set([
  "node_modules",
  "bunfig.toml",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "deno.json",
  "deno.jsonc",
]);

/** Why `path` may not be installed, or undefined when it may. */
export function artifactPathProblem(path: string): string | undefined {
  const parts = path.split("/");
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    /[\\:\u0000-\u001f\u007f]/.test(path) ||
    parts.some((p) => !p || p === "." || p === "..")
  )
    return `${path}: not a relative path with forward slashes`;
  if (path.normalize("NFC") !== path)
    return `${path}: name is not in Unicode normal form C`;
  for (const part of parts) {
    if (part.startsWith("."))
      return `${path}: hidden files and folders are not installed`;
    if (FORBIDDEN_NAMES.has(part.toLowerCase()))
      return `${path}: ${part} configures tools that run code and is not installed`;
  }
  if (/\.(zip|tar|tgz|gz|bz2|xz|zst|7z|rar|jar)$/i.test(path))
    return `${path}: archives are not extracted; declare the individual files instead`;
  return undefined;
}

/** The content checks run on the first bytes of every transferred file. */
export function contentProblem(
  path: string,
  head: Uint8Array,
): string | undefined {
  const text = Buffer.from(head).toString("latin1");
  if (text.startsWith("version https://git-lfs.github.com/spec/")) {
    const oid = /\noid sha256:([0-9a-f]{64})/.exec(text)?.[1];
    const size = /\nsize ([0-9]+)/.exec(text)?.[1];
    return `${path} is a Git LFS pointer${oid ? ` to sha256:${oid}` : ""}${size ? ` (${size} bytes)` : ""}, not the file; DAWN does not fetch LFS objects. Publish the file in Git, as a release asset or on another HTTPS host with its sha256 and bytes`;
  }
  const b = head;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (
    starts(0x50, 0x4b, 0x03, 0x04) ||
    starts(0x50, 0x4b, 0x05, 0x06) ||
    starts(0x1f, 0x8b) ||
    starts(0x42, 0x5a, 0x68) ||
    starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) ||
    starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) ||
    starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07) ||
    starts(0x28, 0xb5, 0x2f, 0xfd) ||
    (b.length >= 262 && text.slice(257, 262) === "ustar")
  )
    return `${path} is an archive; archives are not extracted. Declare the individual files instead`;
  return undefined;
}

/** Report every artifact path problem and case-insensitive collision at once. */
export function checkArtifactPaths(paths: readonly string[]): void {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const problem = artifactPathProblem(path);
    if (problem) problems.push(problem);
    const key = path.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== path)
      problems.push(`${path} and ${other} differ only in case`);
    seen.set(key, path);
  }
  if (problems.length)
    throw new Error(
      problems.length === 1
        ? problems[0]!
        : `${problems.length} files cannot be installed: ${problems.slice(0, 5).join("; ")}`,
    );
}
