// SPDX-License-Identifier: MIT
/** Portable singing scores. Beats are quarter notes and pitch is MIDI. */
const ranges = {
  scoop: [-12, 12],
  fall: [-12, 12],
  glide: [0, 1],
  vib: [0, 2],
  dyn: [0.05, 1.5],
  air: [0, 1],
  gap: [0, 0.5],
} as const;
type Expression = keyof typeof ranges;
export type VocalControl = Expression | "legato" | "spokenAs" | "human";
export type SingingNote = Readonly<
  {
    syl: string;
    beat: number;
    len: number;
    midi: number;
    /** Alternative spelling for this syllable. Word boundaries come from syl. */
    spokenAs?: string;
    legato?: boolean;
  } & Partial<Record<Expression, number>>
>;
export type VocalPhrase = Readonly<{
  id: string;
  beats: number;
  notes: readonly SingingNote[];
  seed?: number;
}>;
export type VocalScore = Readonly<{
  version: 1;
  bpm: number;
  phrases: readonly VocalPhrase[];
  voice?: string;
  seed?: number;
  human?: number;
}>;
export type ResolvedVocalScore = Omit<VocalScore, "phrases"> &
  Readonly<{
    voice: string;
    seed: number;
    phrases: readonly (VocalPhrase & { seed: number })[];
  }>;
export type Voice = Readonly<{
  id: string;
  provider: string;
  version: string;
  language: string;
  controls: readonly VocalControl[];
}>;
export const stockVoice: Voice = {
  id: "kokoro-world/bf_emma",
  provider: "kokoro-world",
  version: "1",
  language: "en-GB",
  controls: [
    ...(Object.keys(ranges) as Expression[]),
    "legato",
    "spokenAs",
    "human",
  ],
};
export type VocalTake = Readonly<{
  takeId: string;
  /** True when the host reused an accepted take. */
  reused?: boolean;
  parts?: Readonly<{ cached: number; sung: number }>;
  wavPath: string;
  sha256: string;
  seconds: number;
  slices: readonly { name: string; begin: number; end: number }[];
  scorePath: string;
  metadataPath: string;
}>;
export type VoiceProvider = Readonly<{
  voices: readonly Voice[];
  render(score: ResolvedVocalScore, signal?: AbortSignal): Promise<VocalTake>;
}>;
export type VocalDiagnostic = Readonly<{ path: string; message: string }>;
class InvalidScore extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(path: string, message: string): never {
  throw new InvalidScore(path, message);
}
function object(value: unknown, path: string, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    fail(path, "Expected an object");
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(path + "." + key, "Unknown field");
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number, path: string) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(path, `Expected a number from ${min} to ${max}`);
  return value;
}
function seed(value: unknown, path: string) {
  const n = number(value, 0, 2147483647, path);
  if (!Number.isInteger(n)) fail(path, "Expected an integer seed");
  return n;
}
// FNV-1a over the ASCII song seed and phrase ID. Part order never enters the hash.
function phraseSeed(songSeed: number, id: string) {
  let hash = 2166136261;
  for (const c of String(songSeed) + "/" + id)
    hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return hash & 0x7fffffff;
}

function resolveScore(
  value: unknown,
  voices: readonly Voice[],
  options: { voice?: string; seed?: number },
): ResolvedVocalScore {
  const input = object(value, "score", [
    "version",
    "bpm",
    "voice",
    "seed",
    "human",
    "phrases",
  ]);
  if (input.version !== 1) fail("version", "Expected vocal score version 1");
  const voiceId =
    options.voice === undefined
      ? input.voice === undefined
        ? stockVoice.id
        : input.voice
      : options.voice;
  const voice = voices.find((v) => v.id === voiceId);
  if (!voice)
    fail(
      "voice",
      typeof voiceId === "string"
        ? "Unknown voice: " + voiceId.slice(0, 128)
        : "Expected a voice ID",
    );
  const spelling =
    voice.id === stockVoice.id
      ? /^[A-Za-z]+(?:'[A-Za-z]+)*$/
      : /^\p{L}[\p{L}\p{M}]*(?:'[\p{L}\p{M}]+)*$/u;
  const bpm = number(input.bpm, 40, 240, "bpm");
  const songSeed = seed(
    options.seed === undefined
      ? input.seed === undefined
        ? 0
        : input.seed
      : options.seed,
    "seed",
  );
  const control = (key: VocalControl, path: string, syl?: string) => {
    if (!voice.controls.includes(key))
      fail(path, `${voice.id} cannot apply ${key}${syl ? " to " + syl : ""}`);
  };
  let human: number | undefined;
  if (input.human !== undefined) {
    control("human", "human");
    human = number(input.human, 0, 1, "human");
  }
  if (
    !Array.isArray(input.phrases) ||
    input.phrases.length < 1 ||
    input.phrases.length > 128
  )
    fail("phrases", "Expected 1 to 128 phrases");
  const ids = new Set<string>();
  let count = 0,
    beatsTotal = 0;
  const phrases = Array.from(input.phrases, (raw: unknown, i) => {
    const path = `phrases[${i}]`;
    const p = object(raw, path, ["id", "beats", "notes", "seed"]);
    if (
      typeof p.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(p.id) ||
      ["constructor", "prototype"].includes(p.id) ||
      ids.has(p.id)
    )
      fail(path + ".id", "Expected a unique lowercase phrase ID");
    ids.add(p.id);
    const beats = number(p.beats, 0.125, 128, path + ".beats");
    beatsTotal += beats + 0.25;
    if ((beatsTotal * 60) / bpm > 600)
      fail(path, "Score exceeds 600 seconds including phrase pickups");
    if (
      !Array.isArray(p.notes) ||
      !p.notes.length ||
      p.notes.length > 256 ||
      (count += p.notes.length) > 4096
    )
      fail(
        path + ".notes",
        "Expected 1–256 notes per phrase and at most 4096 per score",
      );
    let prev = -1,
      prevSyl = "";
    const noteCount = p.notes.length;
    const notes = Array.from(p.notes, (rawNote: unknown, j): SingingNote => {
      const at = path + `.notes[${j}]`;
      const n = object(rawNote, at, [
        "syl",
        "beat",
        "len",
        "midi",
        ...Object.keys(ranges),
        "spokenAs",
        "legato",
      ]);
      const syl = n.syl;
      if (
        typeof syl !== "string" ||
        syl.length > 48 ||
        !(syl === "~" || spelling.test(syl.replace(/-$/, "")))
      )
        fail(at + ".syl", "Expected a syllable, a trailing hyphen, or ~");
      if (syl === "~" && (!prevSyl || prevSyl.endsWith("-")))
        fail(at + ".syl", "A held vowel needs a completed syllable");
      if (j === noteCount - 1 && syl.endsWith("-"))
        fail(at + ".syl", "Incomplete word at end of phrase");
      const beat = number(n.beat, 0, beats, at + ".beat"),
        len = number(n.len, 0.03, beats, at + ".len");
      if (beat <= prev || beat + len > beats + 1e-6)
        fail(
          at + ".beat",
          "Notes must start in order and end inside the phrase",
        );
      prev = beat;
      prevSyl = syl;
      const note = {
        syl,
        beat,
        len,
        midi: number(n.midi, 24, 108, at + ".midi"),
      } as { -readonly [K in keyof SingingNote]: SingingNote[K] };
      for (const k of Object.keys(ranges) as Expression[])
        if (n[k] !== undefined) {
          control(k, at + "." + k, syl);
          note[k] = number(n[k], ranges[k][0], ranges[k][1], at + "." + k);
        }
      if (n.legato !== undefined) {
        control("legato", at + ".legato", syl);
        if (typeof n.legato !== "boolean")
          fail(at + ".legato", "Expected a boolean");
        note.legato = n.legato;
      }
      if (n.spokenAs !== undefined) {
        control("spokenAs", at + ".spokenAs", syl);
        if (
          syl === "~" ||
          typeof n.spokenAs !== "string" ||
          n.spokenAs.length > 47 ||
          !spelling.test(n.spokenAs)
        )
          fail(at + ".spokenAs", "Expected a spelling for a sung syllable");
        note.spokenAs = n.spokenAs;
      }
      return note;
    });
    return {
      id: p.id,
      beats,
      notes,
      seed:
        p.seed === undefined
          ? phraseSeed(songSeed, p.id)
          : seed(p.seed, path + ".seed"),
    };
  });
  const score = {
    version: 1 as const,
    bpm,
    voice: voice.id,
    seed: songSeed,
    ...(human === undefined ? {} : { human }),
    phrases,
  };
  if (new TextEncoder().encode(JSON.stringify(score)).length > 512 * 1024)
    fail("score", "Score exceeds 512 KiB");
  return score;
}

export function validateVocalScore(
  value: unknown,
  voices: readonly Voice[] = [stockVoice],
  options: { voice?: string; seed?: number } = {},
):
  | { ok: true; score: ResolvedVocalScore }
  | { ok: false; diagnostics: readonly VocalDiagnostic[] } {
  try {
    return { ok: true, score: resolveScore(value, voices, options) };
  } catch (e) {
    if (!(e instanceof InvalidScore)) throw e;
    return { ok: false, diagnostics: [{ path: e.path, message: e.message }] };
  }
}

/** Register providers explicitly in the host. Scores select a registered voice by ID. */
export function createVocals(providers: readonly VoiceProvider[]) {
  const entries = providers.flatMap((p) =>
    p.voices.map((v) => ({ voice: v, provider: p })),
  );
  const voices = entries.map((e) => e.voice);
  if (new Set(voices.map((v) => v.id)).size !== voices.length)
    throw new Error("Duplicate vocal voice ID");
  return {
    voices: { list: () => voices.slice() },
    validate: (
      score: unknown,
      options: { voice?: string; seed?: number } = {},
    ) => validateVocalScore(score, voices, options),
    async render(
      score: VocalScore,
      options: { voice?: string; seed?: number; signal?: AbortSignal } = {},
    ) {
      const result = validateVocalScore(score, voices, options);
      if (!result.ok) {
        const d = result.diagnostics[0]!;
        throw new Error(d.path + ": " + d.message);
      }
      options.signal?.throwIfAborted();
      return entries
        .find((e) => e.voice.id === result.score.voice)!
        .provider.render(result.score, options.signal);
    },
  };
}
