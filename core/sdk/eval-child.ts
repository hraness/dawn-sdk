/**
 * The evaluation subprocess (`bun --no-addons --no-install --no-env-file
 * --smol eval-child.ts`), started and reused by `eval.ts`. Each line on
 * standard input is a request `{ project, entry?, budget }`; each answer is
 * one JSON line on standard output. A request's song is evaluated in a
 * fresh sealed engine (`sandbox.ts`); then, here on the host, sample hashes
 * and Scala tuning files are filled in. Exits when standard input closes.
 * Never imported by DAWN itself.
 *
 * A composer request `{ composer: { sources, entry, brief, maxBytes },
 * budget }` instead calls a composer plug-in (`core/composer-plugin.ts`)
 * with its brief, from the in-memory sources the host read; nothing is read
 * from disk and nothing is filled in. The answer is `{ ok, json }`: the
 * composition as JSON text, at most `maxBytes` long.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { readTuningFiles } from "../tuning.ts";
import { evaluateSandboxed, SANDBOX_MAX_RESULT_BYTES } from "./sandbox.ts";

const MAX_SAMPLE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TUNING_FILE_BYTES = 1024 * 1024;

async function serve(): Promise<void> {
  for await (const line of console) {
    if (line.trim() === "") continue;
    let output: unknown;
    try {
      output = await answer(JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      output = {
        ok: false,
        error: {
          message: `evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    let text = JSON.stringify(output);
    if (text.length > SANDBOX_MAX_RESULT_BYTES)
      text = JSON.stringify({
        ok: false,
        error: {
          file: "song.ts",
          message: `evaluation printed more than ${SANDBOX_MAX_RESULT_BYTES / (1024 * 1024)} MiB; no valid score is that large`,
        },
      });
    process.stdout.write(`${text}\n`);
  }
}

async function answer(request: Record<string, unknown>): Promise<unknown> {
  const budget = Number(request.budget);
  const time = Number.isFinite(budget) && budget > 0 ? { timeMs: budget } : {};
  if (typeof request.composer === "object" && request.composer !== null) {
    const call = request.composer as Record<string, unknown>;
    const files = call.sources as Record<string, unknown>;
    const sources = new Map<string, string>();
    for (const [name, text] of Object.entries(files ?? {}))
      if (typeof text === "string") sources.set(name, text);
    const entry = String(call.entry);
    const maxBytes = Number(call.maxBytes);
    const result = await evaluateSandboxed("/", entry, {
      ...time,
      sources,
      call: String(call.brief),
      what: "composer",
    });
    if (!result.ok) return { ok: false, error: result.error };
    if (!(result.json.length <= maxBytes))
      return {
        ok: false,
        error: {
          file: entry,
          message: `the composer returned more than ${Math.floor(maxBytes / (1024 * 1024))} MiB of JSON`,
        },
      };
    return { ok: true, json: result.json };
  }
  const project = realpathSync(resolve(String(request.project)));
  // `entry` names another file of the project to evaluate as the song (a
  // candidate `song.ts` checked before it is written).
  const entry = typeof request.entry === "string" ? request.entry : "song.ts";
  const result = await evaluateSandboxed(project, entry, time);
  if (!result.ok) return { ok: false, error: result.error };
  const song: unknown = JSON.parse(result.json);
  return {
    ok: true,
    score: withTuningFiles(await withSampleHashes(song, project), project),
  };
}

/**
 * Adds `sha256` to sampler voices, project wavetable files, audio clips and
 * takes that exist and are within the size limit.
 */
async function withSampleHashes(
  song: unknown,
  project: string,
): Promise<unknown> {
  const plain = song as Record<string, unknown>;
  const tracks = Array.isArray(plain.tracks) ? plain.tracks : [];
  const refs: Record<string, unknown>[] = [];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  for (const track of tracks) {
    if (!isObject(track)) continue;
    const sampler = track.sampler;
    if (isObject(sampler) && isObject(sampler.voices))
      for (const voice of Object.values(sampler.voices))
        if (isObject(voice)) refs.push(voice);
    const wavetable = track.wavetable;
    if (isObject(wavetable) && isObject(wavetable.table))
      refs.push(wavetable.table);
    const granular = track.granular;
    if (isObject(granular) && isObject(granular.src)) refs.push(granular.src);
    // 0.7 audio clips and takes: a fresh `audio("samples/x.wav")` is pinned
    // here; a written pin is kept and `dawn check` re-hashes it.
    for (const key of ["clips", "takes"])
      for (const item of Array.isArray(track[key]) ? track[key] : [])
        if (isObject(item)) refs.push(item);
  }
  for (const ref of refs) {
    if (
      typeof ref.src !== "string" ||
      typeof ref.sha256 === "string" ||
      ref.src.startsWith("pack:") ||
      ref.src.startsWith("builtin:")
    )
      continue;
    const path = resolve(project, ref.src);
    if (relative(project, path).startsWith("..")) continue;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_SAMPLE_FILE_BYTES) continue;
      ref.sha256 = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    } catch {
      // Missing file: left for `dawn check` to report.
    }
  }
  return plain;
}

/**
 * Reads the Scala `.scl` and `.kbm` files a song or track tuning names, so
 * the score carries the resolved table and renders without file access.
 */
function withTuningFiles(score: unknown, project: string): unknown {
  if (typeof score !== "object" || score === null) return score;
  const plain = score as Record<string, unknown>;
  const read = (path: string): string | undefined => {
    const file = resolve(project, path);
    if (relative(project, file).startsWith("..")) return undefined;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > MAX_TUNING_FILE_BYTES) return undefined;
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  if (plain.tuning) plain.tuning = readTuningFiles(plain.tuning, read, "song");
  for (const track of Array.isArray(plain.tracks) ? plain.tracks : [])
    if (typeof track === "object" && track !== null && track.tuning)
      track.tuning = readTuningFiles(
        track.tuning,
        read,
        `track ${String(track.name ?? track.id)}`,
      );
  return plain;
}

await serve();
