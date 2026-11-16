/**
 * `dawn song [dir] --composer <folder|collection/entry> [--prompt "<text>"]
 * [--seed n] [--key k] [--tempo bpm] [--bars n] [--form "name:bars ..."]
 * [--mood word] [--energy 0..1] [--palette <palette>] [--vary] [--force]
 * [--json]`: composes with a composer plug-in (`core/composer-plugin.ts`)
 * and writes the song as an ordinary project the user can edit.
 *
 * The same command is the SDK's `dawn-compose` (src/composer-plugin/main.ts),
 * which writes `song.ts` and `tracks/` without DAWN's project files.
 */
import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  COMPOSER_PLUGIN_PROTOCOL,
  composeWithPlugin,
  ComposerPluginError,
  makeBrief,
  printable,
  type ComposedSong,
} from "../../core/composer-plugin.ts";
import type { ComposerSection } from "../../core/sdk/v1.ts";
import { evaluateProject, formatDiagnostic } from "../../core/sdk/eval.ts";
import { printProject } from "../../core/sdk/print.ts";
import type { TrackScore } from "../../core/score.ts";
import { durableWrite } from "../fs/durable.ts";
import {
  loadPalette,
  PaletteSourceError,
  type LoadedPalette,
} from "../palette/source.ts";
import { loadComposer, type LoadedComposer } from "./load.ts";

type Output = { write(text: string): unknown };

/** The record written beside the song: which composer, which bytes, which brief. */
export const COMPOSER_RECORD = "composer.json";
export const COMPOSER_RECORD_SCHEMA = "dawn.composer-run/v1";

export type ComposerSongOptions = Readonly<{
  /** How the command is invoked, for messages: `dawn song` or `dawn-compose`. */
  command: string;
  /** Makes `dir` a DAWN project (dawn.json, the vendored SDK) before writing. */
  initProject?: (dir: string) => Promise<unknown>;
}>;

export const COMPOSER_SONG_USAGE =
  'usage: dawn song [dir] --composer <folder|collection/entry> [--prompt "<text>"] [--seed <n>] [--key "<key>"] [--tempo <bpm>] [--bars <n>] [--form "<name:bars ...>"] [--mood <word>] [--energy <0..1>] [--palette <palette.json|collection/entry>] [--vary] [--force] [--json]';

const VALUED = new Set([
  "--composer",
  "--prompt",
  "--seed",
  "--key",
  "--tempo",
  "--bars",
  "--form",
  "--mood",
  "--energy",
  "--palette",
  "--timeout-ms",
]);
const FLAGS = new Set(["--vary", "--force", "--json", "--help", "-h"]);

type Parsed = { dir?: string; values: Map<string, string>; flags: Set<string> };

function parse(argv: readonly string[]): Parsed | string {
  const out: Parsed = { values: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUED.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) return `${name} needs a value`;
      if (out.values.has(name)) return `${name} is given twice`;
      out.values.set(name, value);
    } else if (FLAGS.has(arg)) out.flags.add(arg);
    else if (arg.startsWith("-")) return `unknown option ${arg}`;
    else if (out.dir === undefined) out.dir = arg;
    else return `unexpected argument ${arg}`;
  }
  return out;
}

/** `--form "intro:4 verse:8 chorus:8"`. */
export function parseForm(text: string): ComposerSection[] {
  const sections = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const match = /^([a-z][a-z0-9-]*):(\d{1,3})$/.exec(token);
      if (!match)
        throw new ComposerPluginError(
          `--form takes name:bars words, for example "intro:4 verse:8"; got ${JSON.stringify(token.slice(0, 40))}`,
        );
      return { name: match[1]!, bars: Number(match[2]) };
    });
  if (sections.length === 0)
    throw new ComposerPluginError("--form names no section");
  return sections;
}

function numberOf(
  values: Map<string, string>,
  name: string,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value))
    throw new ComposerPluginError(`${name} takes a number`);
  return value;
}

/** Writes the palette devices the voiced sounds run into `devices/`. */
async function writeDevices(
  target: string,
  palette: LoadedPalette,
  composed: ComposedSong,
): Promise<string[]> {
  const written: string[] = [];
  for (const device of composed.devices) {
    const bytes = palette.devices.get(device.file)!;
    const path = join(target, "devices", basename(device.file));
    const had = await readFile(path).catch(() => undefined);
    if (had && !Buffer.from(had).equals(Buffer.from(bytes)))
      throw new ComposerPluginError(
        `devices/${basename(device.file)} already holds another device; rename one`,
      );
    if (!had) {
      await mkdir(join(target, "devices"), { recursive: true });
      await writeFile(path, bytes, { flag: "wx" });
    }
    written.push(`devices/${basename(device.file)}`);
  }
  return written;
}

function originText(composer: LoadedComposer): string {
  const o = composer.origin;
  return o.type === "path" ? o.path : `${o.name}/${o.entry}`;
}

export async function runComposerSong(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
  options: ComposerSongOptions,
): Promise<number> {
  const cmd = options.command;
  const usage = COMPOSER_SONG_USAGE.replace("dawn song", cmd);
  const parsed = parse(argv.slice(1));
  if (typeof parsed === "string") {
    stderr.write(`${cmd}: ${parsed} · ${usage}\n`);
    return 2;
  }
  if (parsed.flags.has("--help") || parsed.flags.has("-h")) {
    stdout.write(`${usage}\n`);
    return 0;
  }
  const ref = parsed.values.get("--composer");
  if (ref === undefined) {
    stderr.write(`${cmd}: --composer is required · ${usage}\n`);
    return 2;
  }
  const target = resolve(cwd, parsed.dir ?? ".");
  const shown = parsed.dir ?? ".";
  try {
    const seedText = parsed.values.get("--seed");
    const seed =
      seedText === undefined ? randomInt(0, 2 ** 31) : Number(seedText);
    const vary = parsed.flags.has("--vary");
    const existing = await readFile(join(target, "song.ts"), "utf8").catch(
      () => undefined,
    );
    if (vary && existing === undefined)
      throw new ComposerPluginError(
        `--vary needs a song: ${join(shown, "song.ts")} does not exist`,
      );
    if (
      existing !== undefined &&
      !parsed.flags.has("--force") &&
      !/tracks:\s*\[\s*\]/.test(existing)
    ) {
      stderr.write(
        `${cmd}: ${join(shown, "song.ts")} has a song · pass --force to replace it${vary ? " with its variation" : ""}\n`,
      );
      return 1;
    }
    // A composer.json that is not DAWN's (PHP's Composer uses the name) is
    // not replaced without --force.
    const record0 = await readFile(join(target, COMPOSER_RECORD), "utf8").catch(
      () => undefined,
    );
    if (
      record0 !== undefined &&
      !parsed.flags.has("--force") &&
      !record0.includes(`"schema": "${COMPOSER_RECORD_SCHEMA}"`)
    ) {
      stderr.write(
        `${cmd}: ${join(shown, COMPOSER_RECORD)} is not DAWN's · pass --force to replace it\n`,
      );
      return 1;
    }
    let palette: LoadedPalette | undefined;
    const paletteArg = parsed.values.get("--palette");
    if (paletteArg !== undefined)
      palette = await loadPalette(paletteArg, cwd, [target, cwd]);
    const composer = await loadComposer(ref, cwd, [target, cwd]);
    let score: TrackScore | undefined;
    if (vary) {
      const evaluated = await evaluateProject(target);
      if (!evaluated.ok)
        throw new ComposerPluginError(
          `--vary: ${evaluated.diagnostics.map(formatDiagnostic).join("; ")}`,
        );
      score = evaluated.score;
    }
    const formText = parsed.values.get("--form");
    const timeout = numberOf(parsed.values, "--timeout-ms");
    const brief = makeBrief({
      seed,
      ...(parsed.values.has("--prompt")
        ? { prompt: parsed.values.get("--prompt")! }
        : {}),
      ...(parsed.values.has("--key")
        ? { key: parsed.values.get("--key")! }
        : {}),
      ...(parsed.values.has("--tempo")
        ? { tempo: numberOf(parsed.values, "--tempo")! }
        : {}),
      ...(parsed.values.has("--bars")
        ? { bars: numberOf(parsed.values, "--bars")! }
        : {}),
      ...(formText !== undefined ? { form: parseForm(formText) } : {}),
      ...(parsed.values.has("--mood")
        ? { mood: parsed.values.get("--mood")! }
        : {}),
      ...(parsed.values.has("--energy")
        ? { energy: numberOf(parsed.values, "--energy")! }
        : {}),
      ...(palette ? { palette: palette.palette } : {}),
      ...(score ? { score } : {}),
    });
    if (
      timeout !== undefined &&
      (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000)
    )
      throw new ComposerPluginError("--timeout-ms takes 100..60000");
    const composed = await composeWithPlugin(composer, brief, {
      ...(palette ? { palette: palette.palette } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    });

    if (options.initProject) await options.initProject(target);
    else await mkdir(target, { recursive: true });
    const devices = palette
      ? await writeDevices(target, palette, composed)
      : [];
    for (const file of printProject(composed.score).files)
      await durableWrite(join(target, file.path), file.text);
    const { score: _varied, ...asked } = brief;
    const m = composer.manifest;
    const record = {
      schema: COMPOSER_RECORD_SCHEMA,
      protocol: COMPOSER_PLUGIN_PROTOCOL,
      composer: {
        id: m.id,
        version: m.version,
        title: m.title,
        author: m.author,
        license: m.license,
        sha256: composer.sha256,
        origin: composer.origin,
      },
      brief: { ...asked, ...(vary ? { vary: true } : {}) },
      ...(palette
        ? {
            palette: {
              id: palette.palette.id,
              version: palette.palette.version,
              sha256: palette.sha256,
            },
          }
        : {}),
      voices: composed.voices,
      ...(composed.summary ? { summary: composed.summary } : {}),
    };
    await durableWrite(
      join(target, COMPOSER_RECORD),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    const s = composed.score;
    const tracks = s.tracks.length;
    if (parsed.flags.has("--json")) {
      stdout.write(
        `${JSON.stringify(
          {
            dir: target,
            seed,
            composer: record.composer,
            tracks,
            notes: s.notes.length,
            bars: s.bars,
            tempo: s.tempoBpm,
            key: s.key,
            voices: composed.voices,
            ...(composed.summary ? { summary: composed.summary } : {}),
            ms: composed.ms,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      stdout.write(
        `composed with ${m.id} ${m.version} (${originText(composer)}, sha256 ${composer.sha256.slice(0, 12)}) · seed ${seed} · ${tracks} ${tracks === 1 ? "track" : "tracks"} · ${s.bars} bars · ${s.tempoBpm} BPM${s.key ? ` ${printable(s.key)}` : ""} · ${composed.ms} ms\n`,
      );
      if (composed.summary) stdout.write(`${printable(composed.summary)}\n`);
      for (const [track, sound] of Object.entries(composed.voices))
        stdout.write(`voiced ${printable(track)} with ${sound}\n`);
      stdout.write(
        `wrote ${shown} (song.ts, tracks/, ${COMPOSER_RECORD}${devices.length ? ", devices/" : ""})\n`,
      );
    }
    return 0;
  } catch (error) {
    if (
      error instanceof ComposerPluginError ||
      error instanceof PaletteSourceError
    ) {
      stderr.write(`${cmd}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
