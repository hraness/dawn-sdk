// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { ambientVoicingNames } from "../sdk/v1.ts";
import { browserInstruments } from "../../src/renderer/browser.ts";
import { INSTRUMENT_ICONS } from "../icons/instruments.ts";
import {
  DAWN_ICON_PATHS,
  createIcon,
  instrumentIcon,
  parameterIcon,
  type DawnIconName,
} from "./icons.ts";

test("every studio glyph is stroke path data and the DAWN player drawings are preserved verbatim", () => {
  for (const [name, path] of Object.entries(INSTRUMENT_ICONS)) {
    expect(DAWN_ICON_PATHS[name as DawnIconName]).toBe(path);
  }
  expect(Object.isFrozen(DAWN_ICON_PATHS)).toBe(true);
  for (const d of Object.values(DAWN_ICON_PATHS)) {
    expect(d).toMatch(/^M[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/);
  }
  expect(DAWN_ICON_PATHS["score-library"]).toBeDefined();
});

test("the instrument catalog and ambient voicings resolve without guessing from the user's track name", () => {
  for (const id of [...browserInstruments, ...ambientVoicingNames]) {
    expect(instrumentIcon(id), id).not.toBe("generic");
  }
  expect(instrumentIcon("felt")).toBe("piano");
  expect(instrumentIcon("trumpet")).toBe("brass");
  expect(instrumentIcon("nylon")).toBe("guitar");
  expect(instrumentIcon({ instrument: "upright" })).toBe("piano");
  expect(
    instrumentIcon({ instrument: "string", string: { preset: "upright" } }),
  ).toBe("cello");
  expect(
    instrumentIcon({ instrument: "modal", modal: { preset: "glock" } }),
  ).toBe("bells");
  expect(
    instrumentIcon({ instrument: "wind", wind: { preset: "harmon" } }),
  ).toBe("brass");
  expect(
    instrumentIcon({ instrument: "sing", sing: { preset: "choir" } }),
  ).toBe("backing-vocal");
  expect(
    instrumentIcon({ instrument: "texture", texture: { type: "wind" } }),
  ).toBe("air");
  expect(
    instrumentIcon({ instrument: "texture", texture: { type: "birds" } }),
  ).toBe("birds");
  expect(instrumentIcon({ instrument: "future", role: "drums" })).toBe(
    "drum-kit",
  );
  expect(
    instrumentIcon({ instrument: "future", icon: "hi-hat", role: "keys" }),
  ).toBe("hi-hat");
  expect(instrumentIcon({ instrument: "constructor", icon: "toString" })).toBe(
    "generic",
  );
});

test("parameter keys distinguish spatial sends, shaping, and normal mix controls", () => {
  expect(parameterIcon("track.volume")).toBe("level");
  expect(parameterIcon("pan")).toBe("pan");
  expect(parameterIcon("delay.mix")).toBe("echo");
  expect(parameterIcon("reverb.mix")).toBe("room");
  expect(parameterIcon("synth.spread")).toBe("width");
  expect(parameterIcon("synth.lpattack")).toBe("envelope");
  expect(parameterIcon("synth.fmrelease7")).toBe("envelope");
  expect(parameterIcon("synth.lpf")).toBe("filter");
  expect(parameterIcon("string.detune")).toBe("tuning");
  expect(parameterIcon("texture.motion")).toBe("modulation");
  expect(parameterIcon("new-control")).toBe("controls");
});

test("DOM glyphs inherit ink and do not add a focus stop or another accessible name", () => {
  // The public SDK tests also run in Bun without a browser. Record the native
  // SVG operations; string rendering would need a separate escaping policy.
  const nodes: { tag: string; attributes: Map<string, string> }[] = [];
  const document = {
    createElementNS(ns: string, tag: string) {
      expect(ns).toBe("http://www.w3.org/2000/svg");
      const attributes = new Map<string, string>();
      nodes.push({ tag, attributes });
      return {
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
        append() {},
      };
    },
  } as unknown as Document;
  createIcon(document, "level");
  expect(nodes.map(({ tag }) => tag)).toEqual(["svg", "path"]);
  expect(Object.fromEntries(nodes[0]!.attributes)).toMatchObject({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "aria-hidden": "true",
    focusable: "false",
  });
  expect(nodes[1]!.attributes.get("d")).toBe(DAWN_ICON_PATHS.level);
  createIcon(document, "<script>" as DawnIconName);
  expect(nodes.at(-1)!.attributes.get("d")).toBe(DAWN_ICON_PATHS.generic);
});
