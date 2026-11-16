/** Four-chord loops, as roman numerals, for each mode. */
export type Mode = "minor" | "major";

export const LOOPS: Readonly<Record<Mode, readonly (readonly string[])[]>> = {
  minor: [
    ["i", "VI", "III", "VII"],
    ["i", "iv", "VII", "III"],
    ["i", "VII", "VI", "VII"],
    ["i", "v", "VI", "iv"],
  ],
  major: [
    ["I", "V", "vi", "IV"],
    ["I", "IV", "vi", "V"],
    ["vi", "IV", "I", "V"],
    ["I", "iii", "IV", "V"],
  ],
};
