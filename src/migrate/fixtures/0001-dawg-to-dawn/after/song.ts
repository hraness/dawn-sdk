// This song started in dawg; the comment keeps saying "dawg".
import { song, DawnSdkError } from "dawn";
import type { TrackInput } from "dawn";
import bass from "./tracks/bass/track.ts";

const seed = Number(process.env.DAWN_SEED ?? process.env["DAWN_SEED"] ?? 1);
const label = "made with dawg";
const lazy = () => import("dawn");

try {
  void lazy;
} catch (error) {
  if (error instanceof DawnSdkError) throw error;
}

export default song({
  tempo: 120 + seed - 1,
  meter: [4, 4],
  bars: 4,
  tracks: [bass],
  calibration: 1,
  title: `${label} at ${"dawg"}`,
});
export type { TrackInput };
