// SPDX-License-Identifier: MIT
import type { Note } from "../score.ts";

/** The score units understood by the roll. Full DAWN notes can be passed directly. */
export type RollNote = Pick<
  Note,
  "pitch" | "velocity" | "startTick" | "durationTicks"
>;
export type RollMode = "pitch" | "velocity";
export type PianoRollOptions = Readonly<{
  notes: readonly RollNote[];
  bars: number;
  beatsPerBar: number;
  ticksPerBeat: number;
  mode?: RollMode;
  /** Horizontal edit increment in integer ticks. Defaults to a quarter of a beat. */
  snapTicks?: number;
}>;

/** Maximum number of beat columns in a single DOM grid (256 bars in 16/4).
 * Hosts can mount a shorter passage when displaying a longer timeline. */
export const MAX_PIANO_ROLL_BEATS = 4096;

function checkNote(note: RollNote) {
  if (
    !Number.isSafeInteger(note.startTick) ||
    note.startTick < 0 ||
    !Number.isSafeInteger(note.durationTicks) ||
    note.durationTicks < 1 ||
    !Number.isInteger(note.pitch) ||
    note.pitch < 0 ||
    note.pitch > 127 ||
    !Number.isFinite(note.velocity) ||
    note.velocity < 0 ||
    note.velocity > 1
  ) {
    throw new RangeError(
      "A roll note needs integer nonnegative time, positive duration, MIDI pitch 0–127 and velocity 0–1.",
    );
  }
}

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(n, max));

function extent(notes: readonly RollNote[], field: RollMode) {
  if (!notes.length) return { low: 60, high: 60 };
  let low = Infinity;
  let high = -Infinity;
  for (const note of notes) {
    checkNote(note);
    low = Math.min(low, note[field]);
    high = Math.max(high, note[field]);
  }
  return { low, high };
}

/** A miniature of one part. X is time, segment length is duration. Use one path per part. */
export function scoreContourPath(
  notes: readonly RollNote[],
  {
    length,
    width,
    height,
    mode = "pitch",
  }: {
    length: number;
    width: number;
    height: number;
    mode?: RollMode;
  },
): string {
  if (![length, width, height].every((n) => Number.isFinite(n) && n > 0))
    return "";
  const padX = Math.min(1, width / 4);
  const padY = Math.min(2, height / 4);
  const innerWidth = width - 2 * padX;
  const { low, high } = extent(notes, mode);
  const parts: string[] = [];
  for (const note of notes) {
    if (note.startTick >= length || note.startTick + note.durationTicks <= 0)
      continue;
    const x = padX + (innerWidth * Math.max(0, note.startTick)) / length;
    const end =
      padX +
      (innerWidth * Math.min(length, note.startTick + note.durationTicks)) /
        length;
    const y =
      high === low
        ? height / 2
        : padY + ((height - 2 * padY) * (high - note[mode])) / (high - low);
    const span = Math.min(
      width - padX - x,
      Math.max(Math.min(1, innerWidth), end - x),
    );
    parts.push(`M${x.toFixed(2)} ${y.toFixed(2)}h${span.toFixed(2)}`);
  }
  return parts.join(" ");
}

/** Headless layout and snapping for a constant-meter passage. Coordinates are fractions
 * of the plot. X increases to the right and Y increases toward the bottom. */
export function pianoRollLayout({
  notes,
  bars,
  beatsPerBar,
  ticksPerBeat,
  mode = "pitch",
  snapTicks,
}: PianoRollOptions) {
  const beats = bars * beatsPerBar;
  const length = beats * ticksPerBeat;
  const step = snapTicks ?? Math.max(1, Math.round(ticksPerBeat / 4));
  if (
    ![bars, beatsPerBar, ticksPerBeat, length, step].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    step > length
  ) {
    throw new RangeError(
      "The roll needs positive integer timing and a snap increment within the passage.",
    );
  }
  if (beats > MAX_PIANO_ROLL_BEATS)
    throw new RangeError(
      "A piano-roll passage supports at most " +
        MAX_PIANO_ROLL_BEATS +
        " beats.",
    );
  const events = mode === "velocity";
  const { low, high } = extent(notes, "pitch");
  const padding = Math.max(2, Math.ceil((12 - (high - low)) / 2));
  const lowest = events ? 0 : Math.max(0, low - padding);
  const highest = events ? 8 : Math.min(127, high + padding);
  const rows = highest - lowest + 1;
  const rowOf = (note: Pick<RollNote, "pitch" | "velocity">) =>
    events ? Math.round(note.velocity * highest) : note.pitch;
  return {
    lowest,
    highest,
    rows,
    beats,
    length,
    step,
    rowOf,
    /** The returned pitch is a row index in velocity mode (0–8). */
    point(x: number, y: number) {
      return {
        startTick: clamp(
          Math.floor((x * length) / step) * step,
          0,
          Math.floor((length - 1) / step) * step,
        ),
        pitch: clamp(highest - Math.floor(y * rows), lowest, highest),
      };
    },
    /** Snap movement relative to the original note, preserving any humanized timing. */
    drag(
      note: RollNote,
      dx: number,
      dy: number,
      operation: "move" | "resize",
    ): RollNote {
      checkNote(note);
      const dt = Math.round((dx * length) / step) * step;
      if (operation === "resize") {
        const remaining = Math.max(1, length - note.startTick);
        return {
          ...note,
          durationTicks: clamp(
            note.durationTicks + dt,
            Math.min(step, remaining),
            remaining,
          ),
        };
      }
      const dr = Math.round(-dy * rows);
      return {
        ...note,
        startTick: clamp(note.startTick + dt, 0, length - note.durationTicks),
        pitch: events ? note.pitch : clamp(note.pitch + dr, lowest, highest),
        velocity:
          events && dr !== 0
            ? clamp(note.velocity + dr / highest, 0.01, 1)
            : note.velocity,
      };
    },
  };
}

const pitchClasses = [
  "C",
  "C♯",
  "D",
  "E♭",
  "E",
  "F",
  "F♯",
  "G",
  "A♭",
  "A",
  "B♭",
  "B",
];
const pitchLabel = (pitch: number) =>
  pitchClasses[pitch % 12] + String(Math.floor(pitch / 12) - 1);

/** Mount the grid, then add the notes a host wants to display. The host owns selection,
 * keyboard commands, gesture commits and transport; remounting replaces only the host's children. */
export function createPianoRollGrid(
  host: HTMLElement,
  options: PianoRollOptions,
) {
  const grid = pianoRollLayout(options);
  const doc = host.ownerDocument;
  const events = options.mode === "velocity";
  const div = (name: string) => {
    const el = doc.createElement("div");
    el.className = name;
    return el;
  };
  const corner = div("roll-corner");
  const markers = div("roll-beats");
  const axis = div("roll-axis");
  const plot = div("roll-plot");
  for (const el of [corner, markers, axis])
    el.setAttribute("aria-hidden", "true");
  for (let i = 0; i < grid.beats; i++) {
    const beat = i % options.beatsPerBar;
    const mark = doc.createElement("span");
    mark.textContent = beat
      ? String(beat + 1)
      : "Bar " + (Math.floor(i / options.beatsPerBar) + 1);
    mark.classList.toggle("bar-start", beat === 0);
    markers.append(mark);
  }
  for (let row = grid.highest; row >= grid.lowest; row--) {
    const key = doc.createElement("div");
    if (events)
      key.textContent =
        row === 8 ? "Loud" : row === 4 ? "Mid" : row === 0 ? "Soft" : "";
    else if (row % 12 === 0) {
      key.textContent = pitchLabel(row);
      const line = doc.createElement("span");
      line.className = "octave-line";
      line.setAttribute("aria-hidden", "true");
      line.style.top = ((grid.highest - row + 1) / grid.rows) * 100 + "%";
      plot.append(line);
    } else
      key.classList.toggle("black-key", [1, 3, 6, 8, 10].includes(row % 12));
    axis.append(key);
  }
  plot.style.setProperty("--beat-width", 100 / grid.beats + "%");
  plot.style.setProperty("--bar-width", 100 / options.bars + "%");
  plot.style.setProperty("--row-height", 100 / grid.rows + "%");
  host.classList.add("dawn-piano-roll");
  if (!host.hasAttribute("role")) host.setAttribute("role", "group");
  if (
    !host.hasAttribute("aria-label") &&
    !host.hasAttribute("aria-labelledby")
  ) {
    host.setAttribute("aria-label", events ? "Sound events" : "Piano roll");
  }
  host.replaceChildren(corner, markers, axis, plot);
  const place = (element: HTMLElement, note: RollNote) => {
    checkNote(note);
    element.style.left = (note.startTick / grid.length) * 100 + "%";
    element.style.width = (note.durationTicks / grid.length) * 100 + "%";
    element.style.top =
      ((grid.highest - grid.rowOf(note)) / grid.rows) * 100 + "%";
  };
  return {
    ...grid,
    plot,
    place,
    addNote(
      note: RollNote,
      settings: { label?: string; selected?: boolean; tabIndex?: number } = {},
    ) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "roll-note";
      const voice = events
        ? Math.round(note.velocity * 100) + "% strength"
        : pitchLabel(note.pitch);
      const beat = Number(
        (1 + note.startTick / options.ticksPerBeat).toFixed(2),
      );
      button.title = settings.label ?? voice + ", beat " + beat;
      button.setAttribute("aria-label", button.title);
      if (settings.selected !== undefined)
        button.setAttribute("aria-pressed", String(settings.selected));
      button.tabIndex = settings.tabIndex ?? 0;
      place(button, note);
      plot.append(button);
      return button;
    },
  };
}
