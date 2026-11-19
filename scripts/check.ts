// SPDX-License-Identifier: MIT
/**
 * Release check for the exported SDK: every file matches the manifest, every
 * module loads, the palette and collection tools work end to end on the
 * bundled example in a scratch folder, dawn-render writes the exact WAV
 * DAWN writes for the fixture song, and dawn-project makes a project,
 * lints a score, upgrades an old one and sends a score through a link and
 * back.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RENDER_SONG, RENDER_WAV_SHA256 } from "./render-fixture.ts";

import { fileURLToPath } from "node:url";

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
  "scripts/render-fixture.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/auto-tag.yml",
  "tsconfig.json",
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

// Entry points, workers and the evaluator subprocess run when imported;
// the tool runs below cover them.
for (const path of listed)
  if (
    path.endsWith(".ts") &&
    // Example composers import "dawn" and run only in the sealed engine.
    !path.startsWith("examples/") &&
    // Tests run under `bun test`; the migration fixtures are old projects.
    !path.endsWith(".test.ts") &&
    !path.includes("/fixtures/") &&
    !path.endsWith("/main.ts") &&
    !path.endsWith("/eval-child.ts") &&
    !path.endsWith("-worker.ts")
  )
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
      notes: sdk.progression("i VI III VII", { key: "A minor" }),
    }),
  ],
});
if (typeof score !== "object" || score === null)
  fail("song() returned no score");

const browser = await Bun.build({
  entrypoints: [
    fileURLToPath(import.meta.resolve("@hraness/dawn-sdk/browser")),
  ],
  target: "browser",
  minify: true,
});
if (!browser.success || browser.outputs.length !== 1)
  fail("the public browser entry did not bundle on its own");
if (
  new Bun.Transpiler({ loader: "js" }).scanImports(
    await browser.outputs[0]!.text(),
  ).length > 0
)
  fail("the browser bundle contains external imports");

const scratch = mkdtempSync(join(tmpdir(), "dawn-sdk-check-"));
const runIn = (cwd: string, code: number, ...args: string[]) => {
  const result = Bun.spawnSync(["bun", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== code)
    fail(
      `bun ${args.join(" ")} exited ${result.exitCode}, not ${code}\n${result.stderr.toString()}`,
    );
  return result.stdout.toString();
};
const run = (...args: string[]) => runIn(scratch, 0, ...args);
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

  // Render the fixture song from its source, in the sealed evaluator, with
  // its device beside it: the WAV must be the one DAWN writes.
  const song = join(scratch, "song");
  mkdirSync(join(song, "devices"), { recursive: true });
  writeFileSync(join(song, "song.ts"), RENDER_SONG);
  copyFileSync(
    join(root, "examples/devices/fold.wasm"),
    join(song, "devices/fold.wasm"),
  );
  const rendered = run(
    tool("renderer"),
    "song/song.ts",
    "--out",
    "song.wav",
    "--stems",
    "stems",
  );
  const wav = readFileSync(join(scratch, "song.wav"));
  const digest = createHash("sha256").update(wav).digest("hex");
  if (digest !== RENDER_WAV_SHA256)
    fail(`dawn-render wrote ${digest}, DAWN writes ${RENDER_WAV_SHA256}`);
  if (!rendered.includes(digest)) fail("dawn-render did not report its digest");
  for (const stem of ["drums", "bass", "keys", "glass", "premaster"])
    if (!existsSync(join(scratch, "stems", `${stem}.wav`)))
      fail(`dawn-render wrote no ${stem} stem`);
  // The example composer plug-in composes in the sealed engine, and what it
  // writes renders.
  const composed = run(
    tool("composer-plugin"),
    "composed",
    "--composer",
    join(root, "examples/composers/euclid-pulse"),
    "--seed",
    "7",
  );
  if (!composed.includes("composed with euclid-pulse"))
    fail("dawn-compose did not compose with the example");
  run(tool("renderer"), "composed/song.ts", "--out", "composed.wav");
  if (readFileSync(join(scratch, "composed.wav")).length < 44_100)
    fail("dawn-render wrote no audio for the composed song");
  // A score as song() returns it renders from JSON too.
  writeFileSync(join(scratch, "score.json"), JSON.stringify(score));
  run(tool("renderer"), "score.json", "--out", "score.wav");
  if (readFileSync(join(scratch, "score.wav")).length < 44_100)
    fail("dawn-render wrote no audio for score.json");

  // The project tools. A new project's score goes through a link and comes
  // back as the same score; a comment names that score's revision.
  const project = join(root, "src/project/main.ts");
  run(project, "init", "made");
  const made = join(scratch, "made");
  for (const file of ["dawn.json", "song.ts", ".dawn/sdk/v1.ts"])
    if (!existsSync(join(made, file))) fail(`init wrote no ${file}`);
  const link = runIn(made, 0, project, "link").trim();
  if (!/#d1\./.test(link)) fail(`dawn-project link printed ${link}`);
  run(project, "open", link, "opened");
  if (runIn(join(scratch, "opened"), 0, project, "link").trim() !== link)
    fail("a link opened as a project does not make the same link");
  runIn(made, 0, project, "comments", "add", "check", "--agent", "check");
  const comment = JSON.parse(
    readFileSync(join(made, "comments.jsonl"), "utf8").trim(),
  ) as { anchor?: { rev?: string } };
  if (!comment.anchor?.rev || !link.endsWith(comment.anchor.rev))
    fail("the comment does not name the score the link carries");
  // The lint: the score above is in its key, and one note moved a semitone
  // out of it is an error under any calibration.
  if (!run(project, "lint", "score.json").startsWith("lint ok · score "))
    fail("dawn-project lint did not pass the fixture score");
  const notes = (score as { notes: { pitch: number }[] }).notes;
  const flat = notes.findIndex((n) => n.pitch % 12 === 9);
  if (flat < 0) fail("the fixture score has no A to move");
  writeFileSync(
    join(scratch, "wrong.json"),
    JSON.stringify({
      ...score,
      notes: notes.map((n, i) =>
        i === flat ? { ...n, pitch: n.pitch + 1 } : n,
      ),
    }),
  );
  const wrong = runIn(scratch, 1, project, "lint", "wrong.json");
  if (!wrong.includes("error key.scale") || !wrong.includes("lint failed"))
    fail(`dawn-project lint did not report the wrong note\n${wrong}`);
  // A project from before the rename: the plan is a dry run that exits 3,
  // applying it leaves nothing pending.
  const old = join(scratch, "old");
  cpSync(join(root, "src/migrate/fixtures/0001-dawg-to-dawn/before"), old, {
    recursive: true,
  });
  if (!runIn(old, 3, project, "migrate").includes("1 pending"))
    fail("migrate did not plan the rename");
  if (existsSync(join(old, "dawn.json"))) fail("the migrate dry run wrote");
  runIn(old, 0, project, "migrate", "--apply");
  if (!existsSync(join(old, "dawn.json")) || existsSync(join(old, "dawg.json")))
    fail("migrate --apply did not rename the project");
  if (!runIn(old, 0, project, "migrate").includes("up to date"))
    fail("a migrated project still has steps pending");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`check passed: ${listed.size} files match the manifest`);
