/** Local palette authoring: validate data and export a sound as a user patch. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  parsePalettePack,
  type PalettePack,
  type PaletteSound,
} from "../../core/palette.ts";
import { SDK_VERSION } from "../../core/sdk/v1.ts";
import { syncDirectory } from "../fs/durable.ts";

type Output = { write(text: string): unknown };
export const PALETTE_MAX_BYTES = 8 * 1024 * 1024;
export const PALETTE_USAGE =
  "usage: dawn-palette check <manifest.json> [--json]\n       dawn-palette export <manifest.json> <sound-id> <out.patch.json> [--json]\n       dawn-palette pack <manifest.json> <out-dir> [--json]";

const jsonText = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
function patchText(palette: PalettePack, sound: PaletteSound): string {
  return jsonText({
    sdk: SDK_VERSION,
    patch: sound.patch,
    author: palette.author,
    license: palette.license,
    ...(sound.tags ? { tags: sound.tags } : {}),
  });
}

/** Reserve a new container; only its completed pack child is published. */
async function publishPack(
  output: string,
  palette: PalettePack,
): Promise<string> {
  // GitHub patch sources and patch names accept at most 48 characters.
  // Do not silently truncate valid palette IDs into collisions.
  for (const sound of palette.sounds)
    if (sound.id.length > 48)
      throw new Error(`pack sound ID ${sound.id} exceeds 48 characters`);
  const files = new Map<string, string>();
  const patches: Record<string, string> = {};
  for (const sound of palette.sounds) {
    const path = `patches/${sound.id}.json`;
    patches[sound.id] = path;
    files.set(path, patchText(palette, sound));
  }
  files.set("palette.json", jsonText(palette));
  files.set("patches.json", jsonText({ license: palette.license, patches }));
  files.set(
    "SHA256SUMS",
    [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([path, text]) =>
          `${createHash("sha256").update(text).digest("hex")}  ${path}\n`,
      )
      .join(""),
  );

  await mkdir(output, { mode: 0o700 });
  const stage = join(output, `.stage-${randomUUID()}`);
  const target = join(output, "pack");
  await mkdir(stage, { mode: 0o700 });
  await mkdir(join(stage, "patches"), { mode: 0o700 });
  // Leave a failed reservation and its staging files for inspection. Never
  // recursively remove a directory whose contents might have changed.
  for (const [file, text] of files) {
    const handle = await open(join(stage, file), "wx", 0o644);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(join(stage, "patches"));
  await syncDirectory(stage);
  try {
    await lstat(target);
    throw new Error("pack target already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(stage, target);
  await syncDirectory(output);
  await syncDirectory(dirname(output));
  return target;
}

/** The extra byte detects growth after stat without reading an unbounded file. */
async function readManifest(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("manifest must be a regular file");
    if (stat.size > PALETTE_MAX_BYTES)
      throw new Error("manifest exceeds 8 MiB");
    const bytes = Buffer.alloc(PALETTE_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > PALETTE_MAX_BYTES) throw new Error("manifest exceeds 8 MiB");
    return JSON.parse(bytes.toString("utf8", 0, length));
  } finally {
    await handle.close();
  }
}

/** Link a complete, synced file into place; even a racing writer is preserved. */
async function publishNew(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary);
  }
  await syncDirectory(dirname(path));
}

export async function runPaletteCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> {
  const args = argv.slice(1);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    stdout.write(`${PALETTE_USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  const [command, manifest, soundId, output] = positional;
  if (
    args.filter((a) => a === "--json").length > 1 ||
    positional.some((a) => a.startsWith("-")) ||
    !(
      (command === "check" && positional.length === 2) ||
      (command === "pack" && positional.length === 3) ||
      (command === "export" && positional.length === 4)
    )
  ) {
    stderr.write(`${PALETTE_USAGE}\n`);
    return 2;
  }
  try {
    const palette = parsePalettePack(
      await readManifest(resolve(cwd, manifest!)),
    );
    if (command === "check") {
      stdout.write(
        json
          ? `${JSON.stringify({ ok: true, palette: palette.id, version: palette.version, sounds: palette.sounds.length })}\n`
          : `palette ${palette.id} · ${palette.sounds.length} sounds · valid\n`,
      );
      return 0;
    }
    if (command === "pack") {
      const path = await publishPack(resolve(cwd, soundId!), palette);
      stdout.write(
        json
          ? `${JSON.stringify({ ok: true, palette: palette.id, version: palette.version, sounds: palette.sounds.length, pack: path })}\n`
          : `packed ${palette.id} · ${palette.sounds.length} sounds · ${path}\n`,
      );
      return 0;
    }
    const sound = palette.sounds.find((s) => s.id === soundId);
    if (!sound) throw new Error(`no sound ${soundId?.slice(0, 100)}`);
    const path = resolve(cwd, output!);
    await publishNew(path, patchText(palette, sound));
    stdout.write(
      json
        ? `${JSON.stringify({ ok: true, palette: palette.id, sound: sound.id, file: path })}\n`
        : `exported ${palette.id}/${sound.id} · ${path}\n`,
    );
    return 0;
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "output already exists; choose a new path"
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "could not read or export palette";
    stderr.write(`palette: ${reason}\n`);
    return 2;
  }
}
