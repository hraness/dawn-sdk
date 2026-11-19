// SPDX-License-Identifier: MIT
/**
 * What changed in each SDK version, newest first. Pure data: `dawn changes`,
 * the AGENTS.md block, sync's one-line notice and `dawn check`'s fix-its
 * (DAWN1001) read it. `changes.test.ts` holds it to the export snapshot
 * (`exports.snapshot.json`), JSDoc `@since` tags and CHANGELOG sections.
 */

export type SdkChange = Readonly<{
  /** SDK version, e.g. "1.42.0" (`SDK_VERSION`). */
  sdk: string;
  /** The dawn CLI version that first shipped it. */
  dawn: string;
  /** Exported symbols or `TypeName.field`. */
  added?: readonly string[];
  changed?: readonly Readonly<{ symbol: string; note: string }>[];
  removed?: readonly Readonly<{
    symbol: string;
    /** The new name when it is a pure rename (`dawn check --fix` applies it). */
    replacement?: string;
    /** The `dawn migrate` step that rewrites old projects. */
    migration?: string;
  }>[];
  /** EVALS: re-record render baselines when "changed". */
  render?: "changed" | "unchanged";
  /** `dawn check --suggest` detector ids introduced with this change. */
  suggest?: readonly string[];
}>;

export const SDK_CHANGES: readonly SdkChange[] = Object.freeze([
  {
    sdk: "1.54.0",
    dawn: "0.63.0",
    added: [
      "VideoPremise",
      "VideoDialect",
      "VideoBeat",
      "VideoCrowd",
      "VideoTypeInput",
      "VideoTypeInput.face",
      "VideoTypeInput.treatment",
      "VideoTalkInput",
      "VideoTalkInput.section",
      "VideoTalkInput.lines",
      "VideoInput.story",
      "VideoInput.dialect",
      "VideoInput.type",
      "VideoInput.looks",
      "VideoInput.roles",
      "VideoInput.crowd",
      "VideoInput.setPiece",
      "VideoInput.talk",
      "VideoSectionInput.beat",
    ],
    render: "unchanged",
  },
  {
    sdk: "1.53.0",
    dawn: "0.63.0",
    added: ["VideoMoment", "VideoInput.moments"],
    render: "unchanged",
  },
  {
    sdk: "1.52.0",
    dawn: "0.63.0",
    added: [
      "VIDEO_MAX_BYTES",
      "VideoArchiveInput",
      "VideoCamera",
      "VideoCastInput",
      "VideoGround",
      "VideoInput",
      "VideoMoney",
      "VideoPlay",
      "VideoSectionInput",
      "VideoSpec",
      "VideoTime",
      "VideoWeather",
      "video",
      "SongInput.video",
      "VideoArchiveInput.as",
      "VideoArchiveInput.at",
      "VideoArchiveInput.date",
      "VideoArchiveInput.from",
      "VideoArchiveInput.id",
      "VideoArchiveInput.kind",
      "VideoArchiveInput.licence",
      "VideoArchiveInput.sections",
      "VideoArchiveInput.title",
      "VideoArchiveInput.url",
      "VideoCastInput.companion",
      "VideoCastInput.crowd",
      "VideoCastInput.dance",
      "VideoCastInput.flock",
      "VideoCastInput.giant",
      "VideoCastInput.hero",
      "VideoInput.archive",
      "VideoInput.cast",
      "VideoInput.fog",
      "VideoInput.ground",
      "VideoInput.money",
      "VideoInput.motif",
      "VideoInput.palette",
      "VideoInput.props",
      "VideoInput.sections",
      "VideoInput.seed",
      "VideoInput.time",
      "VideoInput.title",
      "VideoInput.weather",
      "VideoSectionInput.camera",
      "VideoSectionInput.ground",
      "VideoSectionInput.palette",
      "VideoSectionInput.place",
      "VideoSectionInput.play",
      "VideoSectionInput.props",
      "VideoSectionInput.time",
      "VideoSectionInput.weather",
    ],
    render: "unchanged",
  },
  {
    sdk: "1.51.0",
    dawn: "0.61.0",
    added: [
      "COMPOSER_PLUGIN_PROTOCOL",
      "COMPOSER_SOUND_ROLES",
      "ComposerBrief",
      "ComposerFunction",
      "ComposerSection",
      "ComposerSound",
      "ComposerSoundRole",
      "Composition",
      "composer",
      "seededRandom",
    ],
    render: "unchanged",
  },
  {
    sdk: "1.50.0",
    dawn: "0.61.0",
    added: ["noteIdFor"],
    changed: [
      {
        symbol: "Expression",
        note: "a note or hit may carry its own id, which seeds its humanize, noise and phase; the printer writes it only when it is not the derived one",
      },
    ],
    render: "unchanged",
  },
  {
    sdk: "1.49.0",
    dawn: "0.60.0",
    added: [
      "DEVICE_ABI",
      "DeviceHash",
      "DeviceKind",
      "WasmDevice",
      "wasmDevice",
    ],
    changed: [
      {
        symbol: "PatchKit",
        note: "device.fx, device.synth and device.notes run WebAssembly devices",
      },
    ],
    render: "unchanged",
  },
  {
    sdk: "1.48.0",
    dawn: "0.55.0",
    changed: [
      {
        symbol: "rand",
        note: "DAWN cycle/seed mapping; re-evaluated source gets new values, baked scores stay unchanged",
      },
      { symbol: "perlin", note: "smooths the new DAWN random lattice" },
      { symbol: "irand", note: "uses the new DAWN random mapping" },
      {
        symbol: "signalAt",
        note: "random cycle and seed are independent keys",
      },
      { symbol: "signalSeed", note: "uses a full unsigned 32-bit track hash" },
    ],
    render: "changed",
  },
  {
    sdk: "1.47.0",
    dawn: "0.54.0",
    changed: [
      {
        symbol: "MasterInput.limiter",
        note: "dcblock removes offset after limiting; off by default",
      },
    ],
    render: "changed",
  },
  {
    sdk: "1.46.0",
    dawn: "0.54.0",
    added: ["MasterInput.tone", "MasterInput.mseq", "MasterInput.multiband"],
    render: "unchanged",
  },
  {
    sdk: "1.45.0",
    dawn: "0.50.0",
    added: [
      "texture",
      "TextureSpec",
      "TextureParams",
      "TextureType",
      "TEXTURE_INSTRUMENT",
    ],
    render: "unchanged",
  },
  {
    sdk: "1.44.0",
    dawn: "0.46.0",
    added: ["ReverbInput.center"],
    render: "unchanged",
  },
  {
    sdk: "1.43.0",
    dawn: "0.40.0",
    added: [
      "defineStyle",
      "hard",
      "soft",
      "Hard",
      "Soft",
      "Want",
      "StyleRange",
      "SongStyle",
      "SongStyleInput",
      "SongStyleInput.archetype",
      "SongStyleInput.density",
      "SongStyleInput.drums",
      "SongStyleInput.energy",
      "SongStyleInput.extends",
      "SongStyleInput.form",
      "SongStyleInput.groove",
      "SongStyleInput.harmony",
      "SongStyleInput.instrumentalPeak",
      "SongStyleInput.key",
      "SongStyleInput.lint",
      "SongStyleInput.master",
      "SongStyleInput.mix",
      "SongStyleInput.mode",
      "SongStyleInput.modulation",
      "SongStyleInput.palette",
      "SongStyleInput.register",
      "SongStyleInput.seconds",
      "SongStyleInput.swing",
      "SongStyleInput.tempo",
      "SongStyleInput.tricks",
      "SongStyleInput.vocal",
      "SONG_ARCHETYPES",
      "SongArchetype",
      "GROOVE_FAMILIES",
      "GrooveFamily",
      "VOCAL_SPACES",
      "VocalSpace",
      "SONG_FORMS",
      "SongForm",
      "ENERGY_SHAPES",
      "EnergyShape",
    ],
    render: "unchanged",
  },
  {
    sdk: "1.42.0",
    dawn: "0.39.0",
    added: ["Removed", "removed"],
    render: "unchanged",
  },
]);

/** One line per added, changed or removed symbol of an entry. */
export function changeLines(change: SdkChange): string[] {
  const lines: string[] = [];
  for (const symbol of change.added ?? []) lines.push(`added ${symbol}`);
  for (const { symbol, note } of change.changed ?? [])
    lines.push(`changed ${symbol}: ${note}`);
  for (const { symbol, replacement } of change.removed ?? [])
    lines.push(
      replacement ? `renamed ${symbol} → ${replacement}` : `removed ${symbol}`,
    );
  return lines;
}
