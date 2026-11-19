// SPDX-License-Identifier: MIT
/**
 * `dawn-render`, the SDK's standalone renderer: a score (`song.ts` source or
 * score JSON) plus the patches, samples and devices it names, to a WAV.
 *
 * It renders exactly what `dawn render <out.wav>` writes for the same
 * project: song source is evaluated in the same sealed engine
 * (`core/sdk/eval.ts`), a project's `mix.patch.json` is applied, samples
 * and devices load from the project folder, and the export path
 * (`renderExportAudio`) is shared, so the WAV is byte-identical. It never
 * opens an audio device, never composes and never edits the project: it
 * writes the output file, any stems, and the decoded-sample cache under
 * `.dawn/assets` that `dawn render` also keeps.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  scoreFromJSON,
  ScoreValidationError,
  type TrackScore,
} from "../../core/score.ts";
import {
  evaluateProject,
  EVAL_MAX_OUTPUT_BYTES,
  formatDiagnostic,
} from "../../core/sdk/eval.ts";
import { renderArrangedStems } from "../audio/arrange.ts";
import { renderExportAudio, sampleCredits } from "../audio/export-audio.ts";
import { exportSampleRate } from "../audio/measure.ts";
import {
  hasSamplerTracks,
  SampleLibrary,
  type SampleBank,
} from "../audio/samples.ts";
import { stemFileName, stemWav } from "../audio/stems.ts";
import { applyMixPatch, readMixPatch } from "../mixqa/patch.ts";

type Output = { write(text: string): unknown };

export const RENDER_SDK_USAGE =
  "usage: dawn-render <song.ts|score.json> --out <file.wav> [--stems <dir>] [--rate <hz>]";

/** Song source modules `dawn-render` evaluates; anything else is score JSON. */
const SOURCE = /\.(?:ts|mts|js|mjs)$/i;

export async function runRenderSdkCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`${RENDER_SDK_USAGE}\n`);
    return 0;
  }
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--out" || arg === "--stems" || arg === "--rate") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || options.has(arg)) {
        stderr.write(`${arg} needs one value · ${RENDER_SDK_USAGE}\n`);
        return 2;
      }
      options.set(arg, value);
      index += 1;
    } else if (arg.startsWith("-")) {
      stderr.write(`unknown option · ${arg} · ${RENDER_SDK_USAGE}\n`);
      return 2;
    } else positional.push(arg);
  }
  const input = positional[0];
  const out = options.get("--out");
  if (positional.length !== 1 || !input || !out || !/\.wav$/i.test(out)) {
    stderr.write(`${RENDER_SDK_USAGE}\n`);
    return 2;
  }
  const rateArg = options.get("--rate");
  const rate = rateArg === undefined ? undefined : Number(rateArg);
  if (
    rate !== undefined &&
    (!Number.isInteger(rate) || rate < 8_000 || rate > 48_000)
  ) {
    stderr.write(`render failed · --rate takes 8000 to 48000 Hz\n`);
    return 2;
  }
  const inputPath = resolve(cwd, input);
  // Samples, devices and the mix patch are read from the folder the song or
  // score is in, as `dawn render` reads them from its project.
  const project = dirname(inputPath);
  let score: TrackScore;
  try {
    score = SOURCE.test(inputPath)
      ? await evaluateSource(project, basename(inputPath))
      : await readScore(inputPath);
  } catch (error) {
    stderr.write(`render failed · ${message(error)}\n`);
    return 1;
  }
  let samples: SampleBank | undefined;
  if (hasSamplerTracks(score)) {
    samples = await new SampleLibrary({ projectRoot: project }).load(score);
    for (const problem of samples.problems)
      stderr.write(`sample ${problem.level} · ${problem.message}\n`);
    const failed = samples.problems.filter((p) => p.level === "error").length;
    if (failed > 0) {
      stderr.write(
        `render failed · ${failed} sample ${failed === 1 ? "voice" : "voices"} could not load\n`,
      );
      return 1;
    }
  }
  const sampleRate = rate ?? exportSampleRate(score);
  const { credits, comment } = await sampleCredits(score);
  const stemsDir = options.get("--stems");
  let audio;
  try {
    let rendered;
    if (stemsDir !== undefined) {
      const dir = resolve(cwd, stemsDir);
      const { audio: mixed, stems } = renderArrangedStems(score, {
        samples,
        sampleRate,
      });
      rendered = mixed;
      await mkdir(dir, { recursive: true });
      for (const [name, pair] of stems.stems)
        await writeFile(
          join(dir, `${stemFileName(name)}.wav`),
          stemWav(pair, stems.sampleRate),
        );
      await writeFile(
        join(dir, "premaster.wav"),
        stemWav(stems.preMaster, stems.sampleRate),
      );
      stdout.write(`stems · ${stems.stems.size} + premaster · ${dir}\n`);
    }
    audio = renderExportAudio(
      score.toJSON(),
      samples,
      sampleRate,
      true,
      false,
      comment,
      rendered,
    );
  } catch (error) {
    if (!(error instanceof ScoreValidationError)) throw error;
    stderr.write(`render failed · ${error.message}\n`);
    return 1;
  }
  const path = resolve(cwd, out);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, audio.wav);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  stdout.write(
    `rendered · ${out} · ${(audio.frames / audio.sampleRate).toFixed(2)} s · ${audio.sampleRate} Hz · ${audio.wav.byteLength} bytes · ${audio.sha256}\n`,
  );
  if (credits) stdout.write(`credits · ${credits}\n`);
  if (audio.clipped > 0)
    stderr.write(
      `warning · ${audio.clipped} ${audio.clipped === 1 ? "sample clips" : "samples clip"} at full scale\n`,
    );
  if (audio.nonFinite)
    stderr.write(
      `warning · ${audio.nonFinite.samples} non-finite samples zeroed · from ${audio.nonFinite.tracks.join(", ")}\n`,
    );
  return 0;
}

/** Song source, evaluated in the sealed engine, plus the project's mix patch. */
async function evaluateSource(
  project: string,
  entry: string,
): Promise<TrackScore> {
  const evaluated = await evaluateProject(project, { entry });
  if (!evaluated.ok)
    throw new Error(
      evaluated.diagnostics.map(formatDiagnostic).join("; ").slice(0, 400),
    );
  const patch = await readMixPatch(project);
  return patch ? applyMixPatch(evaluated.score, patch).score : evaluated.score;
}

/** A score as `song()` returns it, serialized: validated from `unknown`. */
async function readScore(path: string): Promise<TrackScore> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${basename(path)} is not a file`);
  if (info.size > EVAL_MAX_OUTPUT_BYTES)
    throw new Error(
      `${basename(path)} exceeds ${EVAL_MAX_OUTPUT_BYTES / (1024 * 1024)} MiB`,
    );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${basename(path)} is not JSON`);
  }
  return scoreFromJSON(value);
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
