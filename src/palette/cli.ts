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
import { compileDevice, DEVICE_LIMITS } from "../../core/device.ts";
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

/**
 * Reads each declared device file beside the manifest (a regular file, no
 * symbolic links, within the module size limit), verifies its sha256 and
 * checks it against `dawn.device/v1`. Nothing in it runs.
 */
export async function readDevices(
  manifest: string,
  palette: PalettePack,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const base = dirname(manifest);
  for (const device of palette.devices ?? []) {
    const path = join(base, device.file);
    for (const part of [join(base, "devices"), path])
      if ((await lstat(part)).isSymbolicLink())
        throw new Error(
          `device ${device.id}: ${device.file} is a symbolic link`,
        );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let bytes: Uint8Array;
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new Error(`device ${device.id}: ${device.file} is not a file`);
      const buffer = Buffer.alloc(DEVICE_LIMITS.maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > DEVICE_LIMITS.maxBytes)
        throw new Error(
          `device ${device.id}: ${device.file} exceeds ${DEVICE_LIMITS.maxBytes} bytes`,
        );
      bytes = new Uint8Array(buffer.subarray(0, length));
    } finally {
      await handle.close();
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== device.sha256)
      throw new Error(
        `device ${device.id}: ${device.file} has sha256 ${digest}, not the declared ${device.sha256}`,
      );
    let kind: string;
    try {
      kind = compileDevice(bytes).kind;
    } catch (error) {
      throw new Error(
        `device ${device.id}: ${error instanceof Error ? error.message : "not a valid device"}`,
      );
    }
    if (kind !== device.kind)
      throw new Error(
        `device ${device.id} is declared ${device.kind} but exports a ${kind} entry`,
      );
    out.set(device.file, bytes);
  }
  return out;
}

/** Reserve a new container; only its completed pack child is published. */
async function publishPack(
  output: string,
  palette: PalettePack,
  devices: ReadonlyMap<string, Uint8Array>,
): Promise<string> {
  // GitHub patch sources and patch names accept at most 48 characters.
  // Do not silently truncate valid palette IDs into collisions.
  for (const sound of palette.sounds)
    if (sound.id.length > 48)
      throw new Error(`pack sound ID ${sound.id} exceeds 48 characters`);
  const files = new Map<string, string | Uint8Array>();
  for (const [file, bytes] of devices) files.set(file, bytes);
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
  if (devices.size > 0) await mkdir(join(stage, "devices"), { mode: 0o700 });
  // Leave a failed reservation and its staging files for inspection. Never
  // recursively remove a directory whose contents might have changed.
  for (const [file, text] of files) {
    const handle = await open(join(stage, file), "wx", 0o644);
    try {
      await (typeof text === "string"
        ? handle.writeFile(text, "utf8")
        : handle.writeFile(text));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(join(stage, "patches"));
  if (devices.size > 0) await syncDirectory(join(stage, "devices"));
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
    const manifestPath = resolve(cwd, manifest!);
    const palette = parsePalettePack(await readManifest(manifestPath));
    const devices = await readDevices(manifestPath, palette);
    const deviceCount = devices.size > 0 ? { devices: devices.size } : {};
    const deviceText =
      devices.size > 0
        ? ` · ${devices.size} ${devices.size === 1 ? "device" : "devices"}`
        : "";
    if (command === "check") {
      stdout.write(
        json
          ? `${JSON.stringify({ ok: true, palette: palette.id, version: palette.version, sounds: palette.sounds.length, ...deviceCount })}\n`
          : `palette ${palette.id} · ${palette.sounds.length} sounds${deviceText} · valid\n`,
      );
      return 0;
    }
    if (command === "pack") {
      const path = await publishPack(resolve(cwd, soundId!), palette, devices);
      stdout.write(
        json
          ? `${JSON.stringify({ ok: true, palette: palette.id, version: palette.version, sounds: palette.sounds.length, ...deviceCount, pack: path })}\n`
          : `packed ${palette.id} · ${palette.sounds.length} sounds${deviceText} · ${path}\n`,
      );
      return 0;
    }
    const sound = palette.sounds.find((s) => s.id === soundId);
    if (!sound) throw new Error(`no sound ${soundId?.slice(0, 100)}`);
    const path = resolve(cwd, output!);
    await publishNew(path, patchText(palette, sound));
    // A sound that plays a device needs its .wasm in the project's devices/.
    const needs = (palette.devices ?? [])
      .filter((device) =>
        sound.patch.nodes.some(
          (node) => node.params?.device === `sha256:${device.sha256}`,
        ),
      )
      .map((device) => device.file);
    stdout.write(
      json
        ? `${JSON.stringify({ ok: true, palette: palette.id, sound: sound.id, file: path, ...(needs.length ? { devices: needs } : {}) })}\n`
        : `exported ${palette.id}/${sound.id} · ${path}${needs.length ? ` · copy ${needs.join(", ")} into the project's devices/` : ""}\n`,
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
