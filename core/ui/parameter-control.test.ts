// SPDX-License-Identifier: MIT
import { test, expect } from "bun:test";
import { TRACK_EFFECT_SPECS } from "../fx.ts";
import {
  createParameterControl,
  parameterScale,
  spaceEffectParameters,
} from "./parameter-control.ts";

test("effect controls use DAWN's current validation and rendering parameter specifications", () => {
  expect(spaceEffectParameters.delay).toBe(TRACK_EFFECT_SPECS.delay.params);
  expect(spaceEffectParameters.reverb).toBe(TRACK_EFFECT_SPECS.reverb.params);
});

test("linear faders snap to their nudge from the minimum and preserve the true endpoints", () => {
  const scale = parameterScale(spaceEffectParameters.delay.beats);
  expect(scale.toAxis(0.32)).toBe(0.32);
  expect(scale.fromAxis(0.32)).toBe(0.3125);
  expect(scale.nudge(0.75, 1)).toBe(0.8125);
  const mix = parameterScale(spaceEffectParameters.reverb.mix, 0.01);
  expect(mix.nudge(0.31, 1)).toBe(0.32);
  expect(mix.fromAxis(-1)).toBe(0);
  expect(mix.fromAxis(9)).toBe(1);
});

test("frequency faders space octaves evenly and nudge in sixths of an octave", () => {
  const freq = parameterScale(spaceEffectParameters.delay.highcut);
  expect(freq.toAxis(2000) - freq.toAxis(1000)).toBeCloseTo(1);
  expect(freq.fromAxis(freq.toAxis(5000))).toBeCloseTo(5000);
  expect(freq.nudge(2000, 6)).toBe(4000);
  expect(freq.nudge(510, -1)).toBe(500);
  expect(freq.fromAxis(freq.upper)).toBe(20000);
  expect(() =>
    parameterScale({ ...spaceEffectParameters.delay.highcut, min: 0 }),
  ).toThrow(RangeError);
  expect(() => parameterScale(spaceEffectParameters.delay.mix, 0)).toThrow(
    RangeError,
  );
});

test("a touch tap commits once with or without a following native change; cancellation restores the committed thumb", () => {
  // Supply the DOM surface the fader writes. Deliver the native input, pointerup,
  // change and cancel sequences directly so this also runs in the SDK's Bun suite.
  let range!: HTMLInputElement;
  const doc = {
    createElement(tag: string) {
      const node = {
        dataset: {},
        style: { setProperty() {} },
        append() {},
        setAttribute() {},
        value: "",
        get valueAsNumber() {
          return Number(this.value);
        },
      };
      if (tag === "input") range = node as unknown as HTMLInputElement;
      return node;
    },
  } as unknown as Document;
  const edits: number[] = [];
  createParameterControl(doc, {
    label: "Room",
    spec: spaceEffectParameters.reverb.mix,
    value: 0.307,
    presentation: "fader",
    step: 0.01,
    onChange: (v) => edits.push(v),
  });
  const preview = (nativeValue: string) => {
    range.value = nativeValue;
    range.oninput!.call(range, { type: "input" } as InputEvent);
    expect(range.value).toBe(nativeValue); // Until release, the native thumb owns its axis.
  };
  const release = () =>
    range.onpointerup!.call(range, { pointerType: "touch" } as PointerEvent);
  const change = () => range.onchange!.call(range, new Event("change"));

  release();
  change();
  expect(range.value).toBe("0.307");
  expect(edits).toEqual([]);
  preview("0.426");
  expect(edits).toEqual([]);
  release();
  expect(edits).toEqual([0.43]);
  change();
  expect(edits).toEqual([0.43]);
  preview("0.517");
  change();
  release();
  expect(edits).toEqual([0.43, 0.52]);
  preview("0.725");
  range.onpointercancel!.call(range, {} as PointerEvent);
  release();
  change();
  expect(range.value).toBe("0.52");
  expect(edits).toEqual([0.43, 0.52]);
});
