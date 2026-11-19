// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import {
  PackStore,
  creditsLine,
  packCredits,
  withWavComment,
} from "./packs.ts";
import { scoreFromJSON, type TrackScore } from "../../core/score.ts";
import { renderArrangedPcm, sectionCues } from "./arrange.ts";
import {
  encodeWav,
  withWavCues,
  RENDER_CHANNELS,
  type RenderedAudio,
} from "./wav.ts";
import { measureRendered } from "./measure.ts";
import type { SampleBank } from "./samples.ts";

/** All full-buffer passes belong on the same side of the worker boundary. */
export function renderExportAudio(
  json: unknown,
  samples: SampleBank | undefined,
  sampleRate: number,
  cues: boolean,
  measure: boolean,
  comment?: string,
  /** Audio already rendered (stems, cached or parallel) for this score. */
  rendered?: RenderedAudio,
) {
  const score = scoreFromJSON(json);
  const audio = rendered ?? renderArrangedPcm(score, { samples, sampleRate });
  let wav = encodeWav(audio.pcm, audio.sampleRate, RENDER_CHANNELS);
  if (cues) wav = withWavCues(wav, sectionCues(score, audio.sampleRate));
  if (comment) wav = withWavComment(wav, comment);
  const sha256 = createHash("sha256").update(wav).digest("hex");
  let clipped = 0;
  for (const sample of audio.pcm)
    if (sample === -32768 || sample === 32767) clipped += 1;
  return {
    wav,
    clipped,
    sha256,
    frames: audio.frames,
    sampleRate: audio.sampleRate,
    master: audio.master,
    nonFinite: audio.nonFinite,
    measurement: measure ? measureRendered(audio, false).mix : undefined,
  };
}
export type ExportAudio = ReturnType<typeof renderExportAudio>;

/**
 * The sample packs a score's voices credit, and the comment an audio
 * render carries for them (part of the WAV's bytes).
 */
export async function sampleCredits(score: TrackScore) {
  const refs = score.tracks.flatMap((track) =>
    Object.values(track.sampler?.voices ?? {}),
  );
  const creditedPacks = refs.some((ref) => ref.src.startsWith("pack:"))
    ? packCredits(refs, await new PackStore().list())
    : undefined;
  const credits = creditedPacks ? creditsLine(creditedPacks) : undefined;
  return {
    creditedPacks,
    credits,
    comment: credits ? `samples: ${credits}` : undefined,
  };
}
