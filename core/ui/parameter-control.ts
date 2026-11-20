// SPDX-License-Identifier: MIT
import { normalizeParam, type NumberParam, type ParamSpec } from "../params.ts";
import { createIcon, type DawnIconName } from "./icons.ts";

export type { ParamSpec, NumberParam } from "../params.ts";

export { spaceEffectParameters } from "../space-effect-params.ts";

type Value = { number: number; boolean: boolean; enum: string };
export type ParameterControlOptions<S extends ParamSpec> = {
  label: string;
  spec: S;
  value?: unknown;
  icon?: DawnIconName;
  presentation?: "field" | "fader";
  /** Override the increment of a numeric fader (e.g. 0.01 for percent mix). */
  step?: number;
  /** Number of minor increments for Page Up and Page Down (default 10). */
  pageSteps?: number;
  format?: (value: number) => string;
  optionLabel?: (id: string) => string;
  onChange: (value: Value[S["kind"]]) => void;
};

/** A linear or logarithmic native range input needs a translation between its
 * axis and the physical values in the score. Rounding happens only while editing. */
export function parameterScale(spec: NumberParam, overrideStep?: number) {
  const { min, max } = spec;
  const step = overrideStep ?? spec.step;
  const log = step === "log";
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min >= max ||
    (log ? min <= 0 : !Number.isFinite(step) || step <= 0)
  ) {
    throw new RangeError("Invalid numeric parameter range or step");
  }
  const bounded = (value: number) => Math.max(min, Math.min(value, max));
  const round = (value: number) =>
    bounded(spec.integer ? Math.round(value) : Number(value.toPrecision(14)));
  const toAxis = (value: number) =>
    log ? Math.log2(bounded(value)) : bounded(value);
  const lower = toAxis(min);
  const upper = toAxis(max);
  return {
    lower,
    upper,
    toAxis,
    fromAxis(axis: number) {
      if (axis <= lower) return min;
      if (axis >= upper) return max;
      return round(
        log ? 2 ** axis : min + Math.round((axis - min) / step) * step,
      );
    },
    nudge(value: number, steps: number) {
      return round(log ? value * 2 ** (steps / 6) : value + step * steps);
    },
  };
}

/** Build a labeled native control using a DAWN parameter specification. The control
 * owns its visible value; an edit calls onChange once when the new value commits. */
export function createParameterControl<S extends ParamSpec>(
  doc: Document,
  options: ParameterControlOptions<S>,
): HTMLLabelElement {
  const { spec, label } = options;
  const initial = normalizeParam(spec, options.value ?? spec.default, label);
  const change = (value: unknown) => {
    const validated = normalizeParam(spec, value, label);
    // normalizeParam checks the discriminant; its return type covers all three kinds.
    options.onChange(validated as Value[S["kind"]]);
  };
  const fader = spec.kind === "number" && options.presentation === "fader";
  const wrapper = doc.createElement("label");
  wrapper.className = fader
    ? "compact-fader dawn-parameter"
    : "field dawn-parameter";
  wrapper.title = spec.doc;
  const name = doc.createElement("span");
  name.dataset.part = "label";
  if (fader) name.className = "fader-label";
  if (options.icon) name.append(createIcon(doc, options.icon));
  name.append(label);
  wrapper.append(name);

  const mark = (control: HTMLInputElement | HTMLSelectElement) => {
    // Explicitly include compact controls in hardware-keyboard traversal on iOS.
    control.tabIndex = 0;
    control.dataset.control = label;
    control.dataset.part = "control";
    control.setAttribute("aria-description", spec.doc);
  };
  if (spec.kind === "enum") {
    const select = doc.createElement("select");
    mark(select);
    for (const id of spec.values) {
      const option = doc.createElement("option");
      option.value = id;
      option.textContent = options.optionLabel?.(id) ?? id;
      select.append(option);
    }
    select.value = String(initial);
    select.onchange = () => change(select.value);
    wrapper.append(select);
    return wrapper;
  }
  const input = doc.createElement("input");
  mark(input);
  if (spec.kind === "boolean") {
    input.type = "checkbox";
    input.checked = Boolean(initial);
    input.onchange = () => change(input.checked);
    wrapper.append(input);
    return wrapper;
  }
  let value = Number(initial);
  const scale = parameterScale(spec, options.step);
  if (!fader) {
    input.type = "number";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = spec.step === "log" ? "any" : String(spec.step);
    input.value = String(value);
    input.onchange = () => {
      if (!Number.isFinite(input.valueAsNumber)) {
        input.value = String(value);
        return;
      }
      const bounded = Math.max(
        spec.min,
        Math.min(input.valueAsNumber, spec.max),
      );
      value = spec.integer ? Math.round(bounded) : bounded;
      input.value = String(value);
      change(value);
    };
    if (spec.step === "log") {
      input.onkeydown = (event) => {
        if (
          (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        event.preventDefault();
        const start = Number.isFinite(input.valueAsNumber)
          ? input.valueAsNumber
          : value;
        value = scale.nudge(start, event.key === "ArrowUp" ? 1 : -1);
        input.value = String(value);
        change(value);
      };
    }
    wrapper.append(input);
    return wrapper;
  }

  const pageSteps = options.pageSteps ?? 10;
  if (!Number.isSafeInteger(pageSteps) || pageSteps <= 0)
    throw new RangeError(
      "A fader page needs a positive integer number of steps",
    );
  input.type = "range";
  input.min = String(scale.lower);
  input.max = String(scale.upper);
  // A stored value can sit between menu increments. Loading a patch must not
  // silently quantize it. Pointer and keyboard edits apply the intended step.
  input.step = "any";
  const rail = doc.createElement("span");
  rail.className = "fader-track";
  rail.dataset.part = "rail";
  const readout = doc.createElement("span");
  readout.className = "fader-value";
  readout.dataset.part = "value";
  readout.setAttribute("aria-hidden", "true");
  const paint = (displayValue = value) => {
    const axis = scale.toAxis(displayValue);
    rail.style.setProperty(
      "--fader-fill",
      (100 * (axis - scale.lower)) / (scale.upper - scale.lower) + "%",
    );
    const text =
      options.format?.(displayValue) ??
      Number(displayValue.toPrecision(5)) + (spec.unit ? " " + spec.unit : "");
    input.setAttribute("aria-valuemin", String(spec.min));
    input.setAttribute("aria-valuemax", String(spec.max));
    input.setAttribute("aria-valuenow", String(displayValue));
    input.setAttribute("aria-valuetext", text);
    readout.textContent = text;
  };
  let preview: number | undefined;
  let committedThumb = "";
  const syncThumb = () => {
    preview = undefined;
    input.value = String(scale.toAxis(value));
    committedThumb = input.value;
    paint();
  };
  // Let the browser own the thumb during a drag. Reassigning its native value
  // from an input event can suppress the final change event in WebKit.
  input.oninput = () => {
    preview = scale.fromAxis(input.valueAsNumber);
    paint(preview);
  };
  const commitThumb = () => {
    if (preview === undefined && input.value === committedThumb) return;
    const next = preview ?? scale.fromAxis(input.valueAsNumber);
    const changed = next !== value;
    value = next;
    syncThumb();
    if (changed) change(value);
  };
  input.onpointercancel = syncThumb;
  // A WebKit touch tap can emit input and pointerup without a change event.
  // Other browsers may emit both. Committing the same thumb position is a no-op.
  input.onpointerup = (event) => {
    if (event.pointerType === "touch" && preview !== undefined) commitThumb();
  };
  input.onchange = commitThumb;
  input.onkeydown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing)
      return;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        value = scale.nudge(value, 1);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        value = scale.nudge(value, -1);
        break;
      case "PageUp":
        value = scale.nudge(value, pageSteps);
        break;
      case "PageDown":
        value = scale.nudge(value, -pageSteps);
        break;
      case "Home":
        value = spec.min;
        break;
      case "End":
        value = spec.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    syncThumb();
    change(value);
  };
  rail.append(input);
  wrapper.append(rail, readout);
  syncThumb();
  return wrapper;
}
