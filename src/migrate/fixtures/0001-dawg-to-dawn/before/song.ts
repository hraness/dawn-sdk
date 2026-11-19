// This song started in dawg; the comment keeps saying "dawg".
import { song, DawgSdkError } from "dawg";
import type { TrackInput } from "dawg";
import bass from "./tracks/bass/track.ts";

const seed = Number(process.env.DAWG_SEED ?? process.env["DAWG_SEED"] ?? 1);
const label = "made with dawg";
const lazy = () => import("dawg");

try {
  void lazy;
} catch (error) {
  if (error instanceof DawgSdkError) throw error;
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
