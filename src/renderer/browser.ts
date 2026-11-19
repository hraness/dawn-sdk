// SPDX-License-Identifier: MIT
/** Render a short, self-contained DAWN score in a browser or a Web Worker. */
import { decodeLoopDocument } from "../../core/loop.ts";
import {
  performNotes,
  performanceTimingFor,
  tunedTiming,
} from "../../core/expression.ts";
import { KEYS_PARAMS } from "../../core/keys.ts";
import { MODAL_PARAMS, MODAL_PRESETS } from "../../core/resonators.ts";
import { SING_PARAMS, SING_PRESETS } from "../../core/sing.ts";
import { STRING_PARAMS, STRING_PRESETS } from "../../core/strings.ts";
import { TEXTURE_PARAMS, TEXTURE_TYPES } from "../../core/texture.ts";
import { WIND_PARAMS, WIND_PRESETS } from "../../core/winds.ts";
import {
  isTrackAudible,
  ScoreValidationError,
  type Note,
  type Track,
} from "../../core/score.ts";
import { LEGACY_SOUNDS, SYNTH_PARAMS, SYNTH_SOUNDS } from "../../core/synth.ts";
import { loopSecondsOf } from "../../core/tempo.ts";
import { resolveTuning } from "../../core/tuning.ts";
import {
  applyDelay,
  applyReverb,
  delayTailFor,
  reverbTailFor,
} from "../audio/effects/space.ts";
import type { InstrumentEngine } from "../audio/instruments.ts";
import { KEYS_ENGINES } from "../audio/keys/engine.ts";
import { MODAL_ENGINE } from "../audio/resonators.ts";
import { SING_ENGINE } from "../audio/sing/engine.ts";
import { STRING_ENGINE } from "../audio/strings/engine.ts";
import { TEXTURE_ENGINE } from "../audio/texture/engine.ts";
import { WIND_ENGINE } from "../audio/winds/engine.ts";
import {
  canonicalSound,
  isStereoVoice,
  renderSynthNote,
  synthTailSeconds,
  usesSynthVoice,
} from "../audio/synth/voice.ts";
import {
  applyPan,
  DEFAULT_SAMPLE_RATE,
  noteSpan,
  oneShotSeconds,
  RENDER_CHANNELS,
  renderToneNote,
  toPcm,
  trackGainAt,
} from "../audio/voice-mix.ts";

export type BrowserPcm = Readonly<{
  /** Signed 16-bit interleaved left/right frames. The buffer can be transferred. */
  pcm: Int16Array;
  channels: 2;
  sampleRate: number;
  /** Time to schedule the next passage, before this passage's release. */
  musicalSeconds: number;
  /** The remaining audio after musicalSeconds, including frame rounding. */
  tailSeconds: number;
}>;

const engines = new Map<string, InstrumentEngine>(
  [
    ...KEYS_ENGINES,
    MODAL_ENGINE,
    SING_ENGINE,
    STRING_ENGINE,
    TEXTURE_ENGINE,
    WIND_ENGINE,
  ].map((engine) => [engine.id, engine]),
);

/** Instrument IDs and parameter definitions for a browser score editor. */
export const browserInstruments = Object.freeze([
  ...new Set([...LEGACY_SOUNDS, ...SYNTH_SOUNDS, ...engines.keys()]),
]);
export const browserParameters = Object.freeze({
  keys: KEYS_PARAMS,
  synth: SYNTH_PARAMS,
  string: STRING_PARAMS,
  wind: WIND_PARAMS,
  modal: MODAL_PARAMS,
  sing: SING_PARAMS,
  texture: TEXTURE_PARAMS,
});
export const browserPresets = Object.freeze({
  modal: Object.keys(MODAL_PRESETS),
  sing: Object.keys(SING_PRESETS),
  string: Object.keys(STRING_PRESETS),
  wind: Object.keys(WIND_PRESETS),
  texture: TEXTURE_TYPES,
});
const emptyBank = { voices: new Map(), problems: [] };
function modeledEngine(track: Track) {
  const engine = engines.get(track.instrument);
  return engine && track[engine.field] ? engine : undefined;
}
const trackFields = new Set([
  "id",
  "name",
  "instrument",
  "muted",
  "solo",
  "volume",
  "pan",
  "volumeAutomation",
  "panAutomation",
  "keys",
  "synth",
  "string",
  "wind",
  "modal",
  "sing",
  "texture",
  "tuning",
  "glide",
  "humanize",
  "velocityCurve",
  "pedal",
  "softPedal",
  "sostenuto",
  "reverb",
  "delay",
  "delayFeedbackAutomation",
  "delayMixAutomation",
  "fxAutomation",
]);
const oscillators = new Set<string>([...LEGACY_SOUNDS, ...SYNTH_SOUNDS]);
function unsupported(field: string): never {
  throw new ScoreValidationError("browser renderer does not support " + field);
}
function checkTrack(t: Track) {
  for (const field of Object.keys(t))
    if (!trackFields.has(field)) unsupported(t.id + "." + field);
  for (const lane of Object.keys(t.fxAutomation ?? {}))
    if (
      !/^(synth|keys|reverb|delay|string|wind|modal|sing|texture)-/.test(lane)
    )
      unsupported(t.id + "." + lane);
  if (t.reverb?.ir) unsupported(t.id + ".reverb.ir");
  const name = canonicalSound(t.instrument);
  if (!modeledEngine(t) && !oscillators.has(name))
    unsupported("instrument " + t.instrument);
}

function prepareBrowserScore(document: unknown, sampleRate: number) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000)
    throw new ScoreValidationError(
      "browser sampleRate must be an integer between 8000 and 48000",
    );
  const score = decodeLoopDocument(document);
  if (
    score.time ||
    score.form.length ||
    score.sections.length ||
    score.loop ||
    score.loopSection
  )
    unsupported("tempo changes, sections, forms or loop ranges");
  if (score.master) unsupported("a master chain");
  const lowestPitch = new Map<string, number>();
  for (const note of score.notes)
    lowestPitch.set(
      note.trackId,
      Math.min(note.pitch, lowestPitch.get(note.trackId) ?? 127),
    );
  let voiceTail = 0,
    roomTail = 0,
    echoTail = 0;
  for (const t of score.tracks) {
    checkTrack(t);
    voiceTail = Math.max(
      voiceTail,
      Math.min(
        30,
        modeledEngine(t)?.tailSeconds(t, lowestPitch.get(t.id), score) ?? 0,
      ),
      Math.min(8, synthTailSeconds(t)),
    );
    roomTail = Math.max(roomTail, reverbTailFor(t, sampleRate));
    echoTail = Math.max(echoTail, delayTailFor(t, score.tempoBpm));
  }
  const musicalSeconds = loopSecondsOf(score);
  const seconds = oneShotSeconds(
    musicalSeconds,
    voiceTail,
    roomTail,
    Math.min(8, echoTail),
  );
  if (musicalSeconds > 45 || seconds > 60)
    throw new ScoreValidationError(
      "browser passage exceeds 45 seconds of music or 60 seconds including its release tail",
    );
  return { score, musicalSeconds, seconds };
}

/** Check a score's browser compatibility and duration without allocating PCM. */
export function validateBrowserScore(document: unknown): void {
  prepareBrowserScore(document, DEFAULT_SAMPLE_RATE);
}

/**
 * Render a track.loop/v1 document from song(). Accepts fixed-tempo passages
 * with DAWN's synthesized tones, modeled piano/electric keys, pan, delay
 * and algorithmic reverb. The whole buffer (music and tails) may span up to
 * 60 seconds, with up to 45 seconds of music. Unsupported audio features and out-of-range inputs throw
 * ScoreValidationError. No filesystem, audio device or network is needed.
 */
export function renderBrowserPcm(
  document: unknown,
  options: Readonly<{ sampleRate?: number }> = {},
): BrowserPcm {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const { score, musicalSeconds, seconds } = prepareBrowserScore(
    document,
    sampleRate,
  );
  const samples = Math.ceil(seconds * sampleRate);
  const context = {
    score,
    samples,
    sampleRate,
    samplesPerTick: (sampleRate * 60) / (score.tempoBpm * score.ticksPerBeat),
    tempoBpm: score.tempoBpm,
    ticksPerBeat: score.ticksPerBeat,
  };
  const mixL = new Float64Array(samples),
    mixR = new Float64Array(samples);
  const left = new Float64Array(samples),
    right = new Float64Array(samples);
  // The offline renderer sums tracks in the order their first note appears.
  const groups = new Map<string, Note[]>();
  for (const note of score.notes) {
    const notes = groups.get(note.trackId);
    if (notes) notes.push(note);
    else groups.set(note.trackId, [note]);
  }
  const tracks = new Map(score.tracks.map((t) => [t.id, t]));
  const timing = performanceTimingFor(score);
  for (const [id, notes] of groups) {
    if (!isTrackAudible(score, id)) continue;
    const t = tracks.get(id)!;
    const tuning = resolveTuning(score.tuning, t.tuning, score.key);
    const voice = { ...context, ...(tuning ? { tuning } : {}) };
    const played = performNotes(t, notes, tunedTiming(timing, score, t));
    left.fill(0);
    right.fill(0);
    const engine = modeledEngine(t);
    const stereo = engine ? engine.stereo(t) : isStereoVoice(t);
    if (engine)
      engine.render(
        left,
        stereo ? right : undefined,
        played,
        t,
        voice,
        emptyBank,
      );
    else if (usesSynthVoice(t)) {
      const gainAt = (tick: number) => trackGainAt(t, tick);
      for (const note of played) {
        const { start, length } = noteSpan(note, context);
        renderSynthNote(
          left,
          stereo ? right : undefined,
          note,
          t,
          start,
          length,
          voice,
          gainAt,
        );
      }
    } else {
      for (const note of played) renderToneNote(left, note, t, context, tuning);
    }
    applyPan(left, left, right, t, context, stereo ? right : undefined);
    if (t.delay) applyDelay(left, right, t, context);
    if (t.reverb) applyReverb(left, right, t, context);
    for (let i = 0; i < samples; i++) {
      mixL[i]! += left[i]!;
      mixR[i]! += right[i]!;
    }
  }
  return {
    pcm: toPcm(mixL, mixR, samples),
    channels: RENDER_CHANNELS,
    sampleRate,
    musicalSeconds,
    tailSeconds: samples / sampleRate - musicalSeconds,
  };
}
