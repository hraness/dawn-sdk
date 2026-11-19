// SPDX-License-Identifier: MIT
/**
 * Composer plug-ins (`dawn.composer-plugin/v1`, docs/composers.md): other
 * people's composers, run as data rather than as programs with the user's
 * authority.
 *
 * A plug-in is a folder holding `dawn.composer.json` and TypeScript (or
 * JavaScript, or JSON) modules. The host reads those files into memory
 * (`src/composer-plugin/load.ts`), and the entry's default export, a
 * `composer((brief) => ...)` from the SDK, is called with the brief in the
 * sealed song engine (`core/sdk/sandbox.ts`): QuickJS compiled to
 * WebAssembly, with no file, network, process, environment, clock or
 * ambient randomness, imports limited to `dawn` (the SDK this runtime ships)
 * and the plug-in's own files, and a memory, stack, time and output bound.
 * The evaluation reads no file: the in-memory sources are all it has.
 *
 * What comes back is checked from `unknown` here: the song is decoded and
 * validated exactly as a `song.ts` result is (`decodeLoopDocument`,
 * `SCORE_LIMITS`), it may name no file (no project samples, wavetables,
 * clips, tuning files or WebAssembly devices: only `builtin:` sources and
 * the bundled studio sounds), and palette voices must name sounds the brief
 * offered. The host then prints it as an ordinary project.
 */
import { BUNDLED_SAMPLE_BASE, BUNDLED_SAMPLES } from "./bundled-samples.ts";
import { parseKey } from "./chords.ts";
import { decodeLoopDocument, encodeLoopDocument } from "./loop.ts";
import type { PaletteDevice, PalettePack, PaletteSound } from "./palette.ts";
import { SYNTH_SOURCE_PREFIX } from "./granular.ts";
import { refreshRhythm } from "./rhythm.ts";
import { ScoreValidationError, TrackScore, updateTrack } from "./score.ts";
import { callComposer, formatDiagnostic } from "./sdk/eval.ts";
import {
  COMPOSER_PLUGIN_PROTOCOL,
  COMPOSER_SOUND_ROLES,
  type ComposerBrief,
  type ComposerSection,
  type ComposerSound,
  type ComposerSoundRole,
  type Song,
} from "./sdk/v1.ts";

export { COMPOSER_PLUGIN_PROTOCOL };
/** The manifest file at a plug-in folder's root. */
export const COMPOSER_MANIFEST = "dawn.composer.json";

export const COMPOSER_PLUGIN_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  /** Modules a plug-in may carry. */
  files: 256,
  /** One module. */
  fileBytes: 1024 * 1024,
  /** Every module together. */
  totalBytes: 4 * 1024 * 1024,
  /** The brief, with a score to vary, as JSON. */
  briefBytes: 8 * 1024 * 1024,
  /** What the composer returns, as JSON. */
  outputBytes: 8 * 1024 * 1024,
  prompt: 4000,
  mood: 64,
  summary: 500,
  sections: 64,
  sectionName: 32,
  /** Wall time for one call. */
  timeMs: 10_000,
  text: 200,
  description: 1000,
});

/** Module files a plug-in loads; anything else in its folder is not read. */
export const COMPOSER_MODULE = /\.(ts|mts|js|mjs|json)$/;

export class ComposerPluginError extends Error {
  override name = "ComposerPluginError";
}

const fail = (message: string): never => {
  throw new ComposerPluginError(message);
};

export type ComposerManifest = Readonly<{
  schema: typeof COMPOSER_PLUGIN_PROTOCOL;
  /** Lowercase slug, up to 64 characters. */
  id: string;
  /** `major.minor.patch`. */
  version: string;
  title: string;
  author: string;
  license: string;
  /** The module whose default export is the composer, relative to the folder. */
  entry: string;
  description?: string;
}>;

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const MANIFEST_FIELDS = new Set([
  "schema",
  "id",
  "version",
  "title",
  "author",
  "license",
  "entry",
  "description",
]);

/**
 * Characters a composer's text may not carry: C0 and C1 controls (terminal
 * escapes) and bidirectional overrides, which could disguise what DAWN prints.
 */
export const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** `text` with every `UNPRINTABLE` character shown as a `\u` escape. */
export function printable(text: string): string {
  return text.replace(
    new RegExp(UNPRINTABLE.source, "g"),
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, what: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max ||
    UNPRINTABLE.test(value)
  )
    fail(`${what} must be text of 1..${max} characters`);
  return value as string;
}

/** A module path inside the plug-in: relative, `/`-separated, no `..`. */
export function isPluginPath(path: string): boolean {
  if (path.length === 0 || path.length > 256) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/** A `dawn.composer.json` from `unknown`; unknown fields are refused. */
export function parseComposerManifest(value: unknown): ComposerManifest {
  if (!isRecord(value)) fail(`${COMPOSER_MANIFEST} is not an object`);
  const m = value as Record<string, unknown>;
  if (m.schema !== COMPOSER_PLUGIN_PROTOCOL)
    fail(`${COMPOSER_MANIFEST} schema must be ${COMPOSER_PLUGIN_PROTOCOL}`);
  for (const key of Object.keys(m))
    if (!MANIFEST_FIELDS.has(key))
      fail(`${COMPOSER_MANIFEST} has an unknown field ${JSON.stringify(key)}`);
  if (typeof m.id !== "string" || m.id.length > 64 || !ID.test(m.id))
    fail(`${COMPOSER_MANIFEST} id must be a lowercase slug`);
  if (typeof m.version !== "string" || !VERSION.test(m.version))
    fail(`${COMPOSER_MANIFEST} version must be major.minor.patch`);
  const entry = text(m.entry, `${COMPOSER_MANIFEST} entry`, 256);
  if (!isPluginPath(entry) || !/\.(ts|mts|js|mjs)$/.test(entry))
    fail(
      `${COMPOSER_MANIFEST} entry must be a .ts or .js module inside the folder`,
    );
  return Object.freeze({
    schema: COMPOSER_PLUGIN_PROTOCOL,
    id: m.id as string,
    version: m.version as string,
    title: text(
      m.title,
      `${COMPOSER_MANIFEST} title`,
      COMPOSER_PLUGIN_LIMITS.text,
    ),
    author: text(
      m.author,
      `${COMPOSER_MANIFEST} author`,
      COMPOSER_PLUGIN_LIMITS.text,
    ),
    license: text(
      m.license,
      `${COMPOSER_MANIFEST} license`,
      COMPOSER_PLUGIN_LIMITS.text,
    ),
    entry,
    ...(m.description === undefined
      ? {}
      : {
          description: text(
            m.description,
            `${COMPOSER_MANIFEST} description`,
            COMPOSER_PLUGIN_LIMITS.description,
          ),
        }),
  });
}

/** A plug-in as the host read it: its manifest and its modules' text. */
export type ComposerPlugin = Readonly<{
  manifest: ComposerManifest;
  /** Modules by `/`-separated path inside the folder. */
  sources: ReadonlyMap<string, string>;
  /** SHA-256 over the sorted paths and file digests: which bytes ran. */
  sha256: string;
}>;

/** What the user asked for, before it is checked into a brief. */
export type BriefInput = Readonly<{
  prompt?: string;
  seed: number;
  key?: string;
  tempo?: number;
  bars?: number;
  form?: readonly ComposerSection[];
  mood?: string;
  energy?: number;
  palette?: PalettePack;
  /** The song to vary. */
  score?: TrackScore;
}>;

/** The palette's sounds a composer may voice a track with, in palette order. */
export function briefSounds(palette: PalettePack | undefined): ComposerSound[] {
  const roles = COMPOSER_SOUND_ROLES as readonly string[];
  return (palette?.sounds ?? [])
    .filter((s) => roles.includes(s.role))
    .map((s) =>
      Object.freeze({
        id: s.id,
        title: s.title,
        role: s.role as ComposerSoundRole,
        ...(s.range ? { range: { min: s.range.min, max: s.range.max } } : {}),
        ...(s.tags?.length ? { tags: [...s.tags] } : {}),
      }),
    );
}

/** A checked brief: every field bounded, absent fields left out. */
export function makeBrief(input: BriefInput): ComposerBrief {
  const L = COMPOSER_PLUGIN_LIMITS;
  const prompt = input.prompt ?? "";
  if (typeof prompt !== "string" || prompt.length > L.prompt)
    fail(`the prompt is longer than ${L.prompt} characters`);
  if (
    !Number.isInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffffffff
  )
    fail("the seed must be a whole number from 0 to 4294967295");
  const brief: Record<string, unknown> = {
    protocol: COMPOSER_PLUGIN_PROTOCOL,
    prompt,
    seed: input.seed,
  };
  if (input.key !== undefined) {
    if (input.key.length > 40 || parseKey(input.key) === undefined)
      fail(`unknown key ${JSON.stringify(input.key)} (for example "A minor")`);
    brief.key = input.key;
  }
  if (input.tempo !== undefined) {
    if (!Number.isFinite(input.tempo) || input.tempo < 20 || input.tempo > 300)
      fail("the tempo must be 20..300 BPM");
    brief.tempo = input.tempo;
  }
  if (input.bars !== undefined) {
    if (!Number.isInteger(input.bars) || input.bars < 1 || input.bars > 256)
      fail("bars must be a whole number 1..256");
    brief.bars = input.bars;
  }
  if (input.form !== undefined) {
    if (input.form.length === 0 || input.form.length > L.sections)
      fail(`the form must have 1..${L.sections} sections`);
    let total = 0;
    brief.form = input.form.map((s) => {
      if (
        typeof s.name !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(s.name) ||
        s.name.length > L.sectionName
      )
        fail(
          `a section name must be a lowercase word, got ${JSON.stringify(s.name)}`,
        );
      if (!Number.isInteger(s.bars) || s.bars < 1 || s.bars > 256)
        fail(`section ${s.name} must be 1..256 bars`);
      total += s.bars;
      return Object.freeze({ name: s.name, bars: s.bars });
    });
    if (total > 256) fail("the form is longer than 256 bars");
    if (input.bars !== undefined && total !== input.bars)
      fail(`the form has ${total} bars, not the ${input.bars} --bars asks for`);
  }
  if (input.mood !== undefined)
    brief.mood = text(input.mood, "the mood", L.mood);
  if (input.energy !== undefined) {
    if (!Number.isFinite(input.energy) || input.energy < 0 || input.energy > 1)
      fail("the energy must be 0..1");
    brief.energy = input.energy;
  }
  brief.sounds = briefSounds(input.palette);
  if (input.score !== undefined)
    brief.score = encodeLoopDocument(input.score) as unknown as Song;
  return brief as ComposerBrief;
}

/**
 * Where a composition names a file or a device. Composer output is
 * self-contained: a sample, wavetable, clip, impulse response or granular
 * source is `builtin:` or one of the bundled studio sounds; a tuning is
 * inline (no `.scl`/`.kbm`); a patch runs no WebAssembly device, except one
 * a palette voice brings.
 */
export function fileReferences(value: unknown): string[] {
  const studio = new Set(
    BUNDLED_SAMPLES.map((s) => `${BUNDLED_SAMPLE_BASE}${s.id}.wav`),
  );
  const found: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (found.length >= 8) return;
    if (depth > 64) {
      found.push(`${path}: nested too deep`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, item] of Object.entries(node)) {
      const at = path ? `${path}.${key}` : key;
      if (
        key === "src" &&
        typeof item === "string" &&
        !item.startsWith("builtin:") &&
        !item.startsWith(SYNTH_SOURCE_PREFIX) &&
        !studio.has(item)
      )
        found.push(`${at} names ${JSON.stringify(item.slice(0, 80))}`);
      else if ((key === "scl" || key === "kbm") && item != null)
        found.push(`${at} names a tuning file`);
      else if (key === "device" && typeof item === "string")
        found.push(`${at} runs a WebAssembly device`);
      else walk(item, at, depth + 1);
    }
  };
  walk(value, "", 0);
  return found;
}

/** A composer's checked result. */
export type ComposedSong = Readonly<{
  score: TrackScore;
  /** Track id → palette sound id, as applied. */
  voices: Readonly<Record<string, string>>;
  summary?: string;
  /** The palette devices the voiced sounds run, to copy beside the song. */
  devices: readonly PaletteDevice[];
}>;

/**
 * The composition JSON a composer returned, checked from `unknown` and
 * voiced: a `{ song, voices?, summary? }` object (or a bare `song()`).
 */
export function parseComposition(
  json: string,
  brief: ComposerBrief,
  palette?: PalettePack,
): ComposedSong {
  const L = COMPOSER_PLUGIN_LIMITS;
  if (json.length > L.outputBytes)
    fail(
      `the composer returned more than ${L.outputBytes / (1024 * 1024)} MiB`,
    );
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    fail("the composer returned invalid JSON");
  }
  if (!isRecord(value)) fail("the composer must return a composition object");
  let record = value as Record<string, unknown>;
  if (record.format !== undefined) record = { song: record };
  for (const key of Object.keys(record))
    if (key !== "song" && key !== "voices" && key !== "summary")
      fail(`the composition has an unknown field ${JSON.stringify(key)}`);
  if (!isRecord(record.song)) fail("the composition has no song");
  const refs = fileReferences(record.song);
  if (refs.length)
    fail(
      `the composition names files or devices, which a composer cannot ship: ${refs.join("; ")}`,
    );
  let score: TrackScore;
  try {
    score = refreshRhythm(decodeLoopDocument(record.song));
  } catch (error) {
    fail(
      `invalid score: ${error instanceof ScoreValidationError || error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Again on the decoded score, where every shorthand (a string `reverb.ir`,
  // a `builtin:` table name) has become the `{ src }` it stands for.
  const decodedRefs = fileReferences(score!.toJSON());
  if (decodedRefs.length)
    fail(
      `the composition names files or devices, which a composer cannot ship: ${decodedRefs.join("; ")}`,
    );
  let summary: string | undefined;
  if (record.summary !== undefined)
    summary = text(record.summary, "the composition summary", L.summary);
  const voices: Record<string, string> = Object.create(null);
  const devices: PaletteDevice[] = [];
  if (record.voices !== undefined) {
    if (!isRecord(record.voices))
      fail("the composition voices is not an object");
    const offered = new Map(brief.sounds.map((s) => [s.id, s]));
    const sounds = new Map<string, PaletteSound>(
      (palette?.sounds ?? []).map((s) => [s.id, s]),
    );
    const entries = Object.entries(record.voices as Record<string, unknown>);
    if (entries.length > 64) fail("the composition voices more than 64 tracks");
    for (const [trackId, soundId] of entries) {
      const track = score!.tracks.find((t) => t.id === trackId);
      if (!track) fail(`voices names no track ${JSON.stringify(trackId)}`);
      if (typeof soundId !== "string" || !offered.has(soundId))
        fail(
          `voices.${trackId} names ${JSON.stringify(soundId)}, which the brief did not offer${brief.sounds.length ? `; sounds: ${brief.sounds.map((s) => s.id).join(", ")}` : " (no --palette)"}`,
        );
      const sound = sounds.get(soundId as string)!;
      if (track!.instrument === "kit")
        fail(
          `voices.${trackId}: a kit track plays drum hits, not a ${sound.role} sound`,
        );
      score = updateTrack(score!, trackId, {
        instrument: "patch",
        patch: sound.patch,
      });
      voices[trackId] = soundId as string;
      for (const device of palette?.devices ?? [])
        if (
          !devices.includes(device) &&
          sound.patch.nodes.some(
            (n) => n.params?.device === `sha256:${device.sha256}`,
          )
        )
          devices.push(device);
    }
    // Voiced tracks are validated again as part of the whole score.
    try {
      score = new TrackScore(score!.toJSON());
    } catch (error) {
      fail(
        `invalid voiced score: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return Object.freeze({
    score: score!,
    voices: Object.freeze(voices),
    ...(summary === undefined ? {} : { summary }),
    devices: Object.freeze(devices),
  });
}

export type ComposeOptions = Readonly<{
  palette?: PalettePack;
  timeoutMs?: number;
}>;

/** Calls `plugin` with `brief` in the sealed engine and checks the result. */
export async function composeWithPlugin(
  plugin: ComposerPlugin,
  brief: ComposerBrief,
  options: ComposeOptions = {},
): Promise<ComposedSong & { ms: number }> {
  const briefJson = JSON.stringify(brief);
  if (briefJson.length > COMPOSER_PLUGIN_LIMITS.briefBytes)
    fail(
      `the brief is larger than ${COMPOSER_PLUGIN_LIMITS.briefBytes / (1024 * 1024)} MiB`,
    );
  const result = await callComposer({
    sources: Object.fromEntries(plugin.sources),
    entry: plugin.manifest.entry,
    brief: briefJson,
    maxBytes: COMPOSER_PLUGIN_LIMITS.outputBytes,
    timeoutMs: options.timeoutMs ?? COMPOSER_PLUGIN_LIMITS.timeMs,
  });
  if (!result.ok)
    // A composer's own error message is third-party text: no escapes reach
    // the terminal.
    fail(
      `${plugin.manifest.id}: ${printable(result.diagnostics.map(formatDiagnostic).join("; ")) || "the composer failed"}`,
    );
  const composed = parseComposition(
    (result as { json: string }).json,
    brief,
    options.palette,
  );
  return { ...composed, ms: result.ms };
}
