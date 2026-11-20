// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import {
  createVocals,
  stockVoice,
  type VocalTake,
  type VoiceProvider,
} from "../../core/vocal-score.ts";

/** Native SDK host. Install Dawn and its voice with dawn setup --install first. */
export function localVoiceProvider(options: {
  projectRoot: string;
  track?: string;
  executable?: string;
}): VoiceProvider {
  return {
    voices: [stockVoice],
    render(score, signal) {
      const args = [
        "vocals",
        "sing",
        "-",
        "--json",
        "--track",
        options.track ?? "vocals",
      ];
      return new Promise<VocalTake>((resolve, reject) => {
        const child = execFile(
          options.executable ?? "dawn",
          args,
          { cwd: options.projectRoot, signal, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(stderr.trim() || error.message, { cause: error }),
              );
              return;
            }
            try {
              const take = JSON.parse(stdout).content;
              if (
                typeof take?.takeId !== "string" ||
                typeof take.scorePath !== "string" ||
                typeof take.wavPath !== "string" ||
                typeof take.metadataPath !== "string" ||
                !/^[a-f0-9]{64}$/.test(take.sha256) ||
                !Array.isArray(take.slices) ||
                !Number.isFinite(take.seconds)
              )
                throw new Error("Dawn returned an invalid vocal take");
              resolve(take);
            } catch (e) {
              reject(e);
            }
          },
        );
        // execFile reports startup/exit failures, including a child exiting before reading stdin.
        child.stdin?.on("error", (e) => {
          if ((e as NodeJS.ErrnoException).code !== "EPIPE") reject(e);
        });
        child.stdin?.end(JSON.stringify(score));
      });
    },
  };
}
export function localVocals(options: Parameters<typeof localVoiceProvider>[0]) {
  return createVocals([localVoiceProvider(options)]);
}
