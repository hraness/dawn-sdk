// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { renderAgentsMd } from "../project/agents-md.ts";
import {
  SDK_TSCONFIG,
  SHIPPED_SDK_PATH,
  sdkVersionOf,
} from "../project/init.ts";
import { VERSION } from "../version.ts";
import type { MigrationContext } from "./types.ts";

/** What the running dawn writes today: shipped SDK, its tsconfig, the AGENTS block. */
export async function defaultMigrationContext(): Promise<MigrationContext> {
  const sdkSource = await readFile(SHIPPED_SDK_PATH, "utf8");
  return Object.freeze({
    dawnVersion: VERSION,
    sdkSource,
    sdkTsconfig: SDK_TSCONFIG,
    agentsBlock: renderAgentsMd({
      sdk: sdkVersionOf(sdkSource) ?? "",
      dawn: VERSION,
    }),
  });
}
