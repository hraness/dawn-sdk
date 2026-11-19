// SPDX-License-Identifier: MIT
/**
 * The project `AGENTS.md` block (design §5.4): what a coding agent in
 * another terminal needs to work on a DAWN project. `dawn init` writes the
 * file when absent (plus `CLAUDE.md` = `@AGENTS.md`).
 *
 * Only light imports (the change table is data): init.ts loads this.
 * Sync replaces the text between the markers when it differs from what the
 * running dawn would write; text outside them is never touched.
 */

import { changeLines, SDK_CHANGES } from "../../core/sdk/changes.ts";

export const AGENTS_BEGIN = "<!-- dawn:begin -->";
export const AGENTS_END = "<!-- dawn:end -->";
export const AGENTS_MD_MAX_BYTES = 6 * 1024;

const BLOCK = `# dawn project

This folder is a dawn song: TypeScript files the dawn SDK evaluates into a score,
rendered offline by the dawn CLI.

## Layout
- \`song.ts\`: tempo, meter, form and the track list (\`export default song({...})\`).
- \`tracks/<slug>/track.ts\`: one \`track({...})\` per track; samples in \`tracks/<slug>/samples/\`.
- Import the SDK as \`import { song, track } from "dawn"\` (vendored in \`.dawn/sdk/v1.ts\`).
- Song source runs sealed: import only \`dawn\` and relative project files; there is no Node or
  Bun API, \`console\`, \`Date\` or \`Math.random\` (use a seeded generator).
- \`.dawn/\` is DAWN's state (sdk, caches). Do not edit it by hand.

## Loop
1. Edit \`song.ts\` or \`tracks/<slug>/track.ts\`.
2. Run \`dawn check\` (or \`dawn check --json\`): typecheck and evaluate; exit 1 lists problems
   with file:line. \`dawn check --fix\` applies safe SDK renames.
3. Run \`dawn render out.wav --measure\` to listen and read loudness; \`out.mid\` writes MIDI.
4. \`dawn changes\` lists what changed in the SDK; \`dawn migrate\` moves an older project forward.

## Trace
- With \`"trace": {"write": true}\` in \`dawn.json\` (new projects), dawn commands record prompts,
  source changes, checks, renders and comments in \`trace/\`. It is committed: a push publishes it.
- Record the request, your decisions and a handoff: \`dawn trace note --kind prompt --text "..."\`,
  then \`--kind decision\` and \`--kind handoff\`. \`DAWN_TRACE_AGENT=<name>\` names you on captured
  commands. Never put credentials in a note; \`dawn trace disable\` stops capture.

## Song workflows
- Read \`dawn workflow list\` and \`dawn workflow read original-house\` before an original song.
- The installed resources contain the canonical house profile, chart format and vocal guidance.
- Before you arrange, mix or revise a song, read \`dawn workflow read original-house
  references/craft.md\`. Keep the song's best part in front, announce an arrival at most once and
  check every sung line on the finished master. The person's stated preferences override it.
- \`dawn make --from <chart.json>\` performs an authored chart: early instrumental, stock bf_emma
  actual words, arrangement and a report.
- \`dawn reference prepare <YouTube-URL-or-audio-file>\` preserves source/stems and timing evidence;
  \`dawn reference recreate <manifest>\` re-sings actual transcribed/supplied words and retains A/B.
- \`dawn setup\` lists what singing and hearing need and what is missing (\`--install\` fetches it); \`dawn reference setup\` explains the reference tools.
- Keep song assets inside this project.

## Audio
- \`dawn media chop --help\`: info, onsets, beats, cut, slice, stretch, pitch, fades and more.
- \`dawn media --help\`: download, stems, analyze, notes (audio to MIDI), sample.
- Outputs are new 24-bit WAVs with a .json sidecar; inputs are never overwritten.

## More
- \`dawn --help\` lists every command; DAWN.md in the dawn package is the full manual.`;

export type AgentsMdMeta = Readonly<{
  /** SDK version vendored by this dawn. */
  sdk: string;
  /** Running dawn version; the block names its major.minor only. */
  dawn: string;
}>;

/** The last three change-table entries, one line per symbol, at most 15 lines. */
export function recentSdkChanges(): string[] {
  const lines: string[] = [];
  for (const change of SDK_CHANGES.slice(0, 3))
    for (const line of changeLines(change))
      lines.push(`- SDK ${change.sdk}: ${line}`);
  return lines.slice(0, 15);
}

/** The dawn-owned block, markers included, ≤ 6 KiB. */
export function renderAgentsMd(meta: AgentsMdMeta): string {
  const dawn = meta.dawn.split(".").slice(0, 2).join(".");
  const recent = recentSdkChanges();
  const extra = [
    "",
    "## Versions",
    `Written by dawn ${dawn} for SDK ${meta.sdk}; \`dawn check\` keeps this block current.`,
    ...(recent.length > 0 ? ["", "Recent SDK changes:", ...recent] : []),
  ].join("\n");
  return `${AGENTS_BEGIN}\n${BLOCK}\n${extra}\n${AGENTS_END}\n`;
}

/**
 * `text` with the content between the dawn markers replaced by `block`
 * (markers included), or undefined when the markers are missing.
 */
export function replaceAgentsBlock(
  text: string,
  block: string,
): string | undefined {
  const begin = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END, begin + AGENTS_BEGIN.length);
  if (begin < 0 || end < 0) return undefined;
  return (
    text.slice(0, begin) +
    block.replace(/\n$/, "") +
    text.slice(end + AGENTS_END.length)
  );
}

/** `CLAUDE.md` written next to a fresh AGENTS.md. */
export const CLAUDE_MD = "@AGENTS.md\n";
