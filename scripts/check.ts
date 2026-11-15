/**
 * Release check for the exported SDK: every file matches the manifest, every
 * module loads, and the palette and collection tools work end to end on the
 * bundled example in a scratch folder.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const fail = (message: string): never => {
  console.error(`check: ${message}`);
  process.exit(1);
};

// The manifest lists the exported payload; the repository adds only these.
const REPOSITORY_FILES = new Set([
  "extension-manifest.json",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "scripts/check.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/auto-tag.yml",
]);

type Entry = { path: string; bytes: number; sha256: string };
const manifest = JSON.parse(
  readFileSync(join(root, "extension-manifest.json"), "utf8"),
) as { files: Entry[] };
const listed = new Set<string>();
for (const entry of manifest.files) {
  const bytes = readFileSync(join(root, entry.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.bytes || digest !== entry.sha256)
    fail(`${entry.path} does not match extension-manifest.json`);
  listed.add(entry.path);
}
const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    if (prefix === "" && [".git", "node_modules"].includes(entry.name))
      return [];
    return entry.isDirectory()
      ? walk(join(dir, entry.name), `${path}/`)
      : [path];
  });
for (const path of walk("."))
  if (!listed.has(path) && !REPOSITORY_FILES.has(path))
    fail(`${path} is not in extension-manifest.json`);

// The CLI entry points run when imported; the tool runs below cover them.
for (const path of listed)
  if (path.endsWith(".ts") && !path.endsWith("/main.ts"))
    await import(join(root, path));

const sdk = await import(join(root, "core/sdk/v1.ts"));
const score = sdk.song({
  tempo: 120,
  key: "A minor",
  bars: 4,
  tracks: [
    sdk.track({
      name: "Drums",
      instrument: "kit",
      rhythm: sdk.pattern("house"),
    }),
    sdk.track({
      name: "Bass",
      instrument: "bass",
      notes: sdk.seq("A1 . F1 . G1 ."),
    }),
    sdk.track({
      name: "Keys",
      instrument: "piano",
      notes: sdk.progression("i VI III VII"),
    }),
  ],
});
if (typeof score !== "object" || score === null)
  fail("song() returned no score");

const scratch = mkdtempSync(join(tmpdir(), "dawn-sdk-check-"));
const run = (...args: string[]) => {
  const result = Bun.spawnSync(["bun", ...args], {
    cwd: scratch,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    fail(`bun ${args.join(" ")}\n${result.stderr.toString()}`);
  return result.stdout.toString();
};
try {
  const palette = join(root, "examples/palettes/glass-weather.json");
  const tool = (name: string) => join(root, "src", name, "main.ts");
  if (!run(tool("palette"), "check", palette).includes("valid"))
    fail("palette check did not report valid");
  run(tool("palette"), "export", palette, "supersaw-bed", "bed.patch.json");
  run(tool("palette"), "pack", palette, "my-sounds");
  for (const file of [
    "bed.patch.json",
    "my-sounds/pack/patches.json",
    "my-sounds/pack/SHA256SUMS",
  ])
    if (!existsSync(join(scratch, file))) fail(`${file} was not written`);
  run(
    tool("collection"),
    "init",
    "my-library",
    "--id",
    "my-library",
    "--title",
    "My library",
    "--curator",
    "Check",
  );
  run(tool("collection"), "check", "my-library/dawn.collection.json");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`check passed: ${listed.size} files match the manifest`);
