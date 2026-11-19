// SPDX-License-Identifier: MIT
/**
 * Where a comment's anchor lands in a score
 * (docs/design/project-trace.md, "The anchor").
 *
 * In the revision the anchor names, the anchor is exact. In any other, the
 * reader looks for what the anchor names: the track, the section, each note
 * row. What it finds, it shows. What it does not find is never dropped: the
 * comment is reported as lost, with the bars and names it had.
 */
import type { TrackScore } from "../score.ts";
import { barAt, barStartTick, loopTicksOf, secondsAtTick } from "../tempo.ts";
import type { AnchorNote, CommentAnchor } from "./events.ts";

/**
 * - `exact`: this is the revision the comment was written on, or everything
 *   the anchor names is still where it says.
 * - `moved`: shown, and not known to be the place: the section is at other
 *   bars now, only some of its notes are left, or all there is to go on is
 *   bars from a revision that is not this one.
 * - `lost`: its track, its section or all of its notes are gone, or its
 *   range is past the end of the song.
 */
export type PlaceState = "exact" | "moved" | "lost";

export type Place = Readonly<{
  state: PlaceState;
  /** What the answer rests on. */
  basis: "revision" | "content" | "bars" | "nothing";
  /** True when the anchor names a revision and it is not this score's. */
  earlier: boolean;
  /** The track now, when the anchor names one and it is still here. */
  track?: Readonly<{ id: string; name: string }>;
  /** The section now, when the anchor names one and it is still here. */
  section?: Readonly<{ name: string; startBar: number; bars: number }>;
  /** A first tick and a tick past the last, in the written score. Null when lost. */
  ticks: readonly [number, number] | null;
  /** The same, in seconds from the start of the written score. */
  seconds: readonly [number, number] | null;
  /** The same, as a first bar and a bar past the last, from 0. */
  bars: readonly [number, number] | null;
  /**
   * Where that range sounds in the song as it plays, in seconds: once for
   * each time the form plays it. One entry, equal to `seconds`, with no form.
   * Null when lost, and when the song has both a form and a time map (including meter or fermatas).
   */
  plays: readonly (readonly [number, number])[] | null;
  /** The anchor's notes that are still in the score. */
  notes: readonly AnchorNote[];
  /** In words: `bass, bars 9 to 12`. Bars count from 1 here, as people do. */
  words: string;
  /** What the anchor said, for a comment that is not exact. */
  was?: Readonly<{
    track?: string;
    section?: string;
    bars?: readonly [number, number];
    ticks?: readonly [number, number];
    notes?: number;
    /** Names the anchor kept from an older file: tracks, then sections. */
    names?: readonly string[];
  }>;
}>;

const fold = (name: string) => name.trim().replace(/\s+/gu, " ").toLowerCase();

/** `bars 9 to 12`, or `bar 9`: a first bar and a bar past the last, from 0. */
export function barsInWords(bars: readonly [number, number]): string {
  const [from, to] = bars;
  return to - from <= 1 ? `bar ${from + 1}` : `bars ${from + 1} to ${to}`;
}

function playsOf(
  score: TrackScore,
  ticks: readonly [number, number],
  seconds: readonly [number, number],
): readonly (readonly [number, number])[] | null {
  if (score.form.length === 0) return [seconds];
  if (score.time !== undefined) return null;
  const barTicks = score.beatsPerBar * score.ticksPerBeat;
  const perTick = 60 / (score.tempoBpm * score.ticksPerBeat);
  const out: (readonly [number, number])[] = [];
  let bar = 0;
  for (const entry of score.form) {
    const section = score.sections.find(
      (item) => fold(item.name) === fold(entry.section),
    );
    if (!section) continue;
    for (let pass = 0; pass < (entry.repeat ?? 1); pass += 1) {
      const from = Math.max(ticks[0], section.startBar * barTicks);
      const to = Math.min(
        ticks[1],
        (section.startBar + section.bars) * barTicks,
      );
      if (to > from) {
        const origin = (bar - section.startBar) * barTicks;
        out.push([(from + origin) * perTick, (to + origin) * perTick]);
      }
      bar += section.bars;
    }
  }
  return out;
}

/**
 * Where `anchor` lands in `score`. `revision` is the score's revision
 * digest when the caller has it; without it nothing is `exact` by revision.
 */
export function placeAnchor(
  anchor: CommentAnchor,
  score: TrackScore,
  revision?: string,
): Place {
  const same = anchor.rev !== undefined && anchor.rev === revision;
  const earlier = anchor.rev !== undefined && revision !== undefined && !same;
  const end = loopTicksOf(score);
  // An anchor moved from the desktop's file keeps the names it had there.
  const names: string[] = [];
  for (const key of ["tracks", "sections"] as const) {
    const list = anchor.was?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, 16)) {
      const name =
        typeof item === "string"
          ? item
          : typeof item === "object" && item !== null
            ? ((item as { name?: unknown }).name ??
              (item as { id?: unknown }).id)
            : undefined;
      if (typeof name === "string" && name !== "")
        names.push(name.slice(0, 128));
    }
  }
  const was = {
    ...(names.length > 0 ? { names } : {}),
    ...(anchor.track !== undefined ? { track: anchor.track } : {}),
    ...(anchor.section !== undefined ? { section: anchor.section } : {}),
    ...(anchor.bars !== undefined ? { bars: anchor.bars } : {}),
    ...(anchor.ticks !== undefined ? { ticks: anchor.ticks } : {}),
    ...(anchor.notes !== undefined ? { notes: anchor.notes.length } : {}),
  };
  const wasWords = () => {
    const parts: string[] = [];
    if (anchor.track !== undefined) parts.push(anchor.track);
    else if (names.length > 0) parts.push(names.join(", "));
    if (anchor.section !== undefined) parts.push(`section ${anchor.section}`);
    if (anchor.bars !== undefined) parts.push(barsInWords(anchor.bars));
    else if (anchor.notes !== undefined)
      parts.push(
        `${anchor.notes.length} ${anchor.notes.length === 1 ? "note" : "notes"}`,
      );
    return parts.join(", ");
  };

  const found = score.tracks.find((track) => track.id === anchor.track);
  const track = found ? { id: found.id, name: found.name } : undefined;
  const sectionFound =
    anchor.section === undefined
      ? undefined
      : score.sections.find(
          (item) => fold(item.name) === fold(anchor.section!),
        );
  const section = sectionFound
    ? {
        name: sectionFound.name,
        startBar: sectionFound.startBar,
        bars: sectionFound.bars,
      }
    : undefined;

  const lost = (): Place => ({
    state: "lost",
    basis: "nothing",
    earlier,
    ...(track ? { track } : {}),
    ...(section ? { section } : {}),
    ticks: null,
    seconds: null,
    bars: null,
    plays: null,
    notes: [],
    words: `on an earlier version${wasWords() ? ` (${wasWords()})` : ""}`,
    was,
  });
  const at = (
    state: "exact" | "moved",
    basis: Place["basis"],
    range: readonly [number, number],
    notes: readonly AnchorNote[] = [],
  ): Place => {
    const ticks: readonly [number, number] = [
      Math.max(0, Math.min(range[0], end)),
      Math.max(0, Math.min(range[1], end)),
    ];
    const seconds: readonly [number, number] = [
      secondsAtTick(score, ticks[0]),
      secondsAtTick(score, ticks[1]),
    ];
    const last = barAt(score, Math.max(ticks[0], ticks[1] - 1)).bar;
    const bars: readonly [number, number] = [
      barAt(score, ticks[0]).bar,
      last + 1,
    ];
    const whole = ticks[0] === 0 && ticks[1] === end;
    const parts: string[] = [];
    if (track) parts.push(track.name);
    if (section && anchor.bars === undefined && notes.length === 0)
      parts.push(`section ${section.name}`);
    else if (!whole || notes.length > 0) parts.push(barsInWords(bars));
    if (notes.length > 0)
      parts.push(`${notes.length} ${notes.length === 1 ? "note" : "notes"}`);
    const words = parts.length === 0 ? "the song" : parts.join(", ");
    return {
      state,
      basis,
      earlier,
      ...(track ? { track } : {}),
      ...(section ? { section } : {}),
      ticks,
      seconds,
      bars,
      plays: playsOf(score, ticks, seconds),
      notes,
      words:
        state === "moved"
          ? `${words}, ${anchor.rev === undefined ? "version not recorded" : "from an earlier version"}`
          : words,
      ...(state === "exact" ? {} : { was }),
    };
  };

  if (anchor.track !== undefined && !track) return lost();
  if (anchor.section !== undefined && !section) return lost();

  const fromBars = (bars: readonly [number, number]) =>
    [barStartTick(score, bars[0]), barStartTick(score, bars[1])] as const;
  const inSong = (range: readonly [number, number]) => range[0] < end;

  // Notes are the finest thing an anchor names, so they are looked for first.
  if (anchor.notes !== undefined && anchor.notes.length > 0) {
    const have = new Set<string>();
    for (const note of score.notes)
      if (note.trackId === anchor.track)
        have.add(`${note.startTick}:${note.durationTicks}:${note.pitch}`);
    const kept = anchor.notes.filter((row) => have.has(row.join(":")));
    if (kept.length > 0) {
      const range = [
        Math.min(...kept.map((row) => row[0])),
        Math.max(...kept.map((row) => row[0] + Math.max(1, row[1]))),
      ] as const;
      const all = kept.length === anchor.notes.length;
      return at(
        all ? "exact" : "moved",
        same ? "revision" : "content",
        range,
        kept,
      );
    }
    // Old bars explain the lost place; they do not stand for removed notes.
    return lost();
  }

  const range =
    anchor.ticks ?? (anchor.bars ? fromBars(anchor.bars) : undefined);
  if (range) {
    if (!inSong(range)) return lost();
    if (same) return at("exact", "revision", range);
    if (section) {
      const span = fromBars([
        section.startBar,
        section.startBar + section.bars,
      ]);
      // Still inside its section: as good as the anchor can be checked.
      if (range[0] >= span[0] && range[1] <= span[1])
        return at("exact", "content", range);
      return at("moved", "content", span);
    }
    return at("moved", "bars", range);
  }
  if (section)
    return at(
      "exact",
      same ? "revision" : "content",
      fromBars([section.startBar, section.startBar + section.bars]),
    );
  // A track, or the song: there as long as it is there.
  return at("exact", same ? "revision" : "content", [0, end]);
}
