// SPDX-License-Identifier: MIT
/**
 * The DAWN app leaves the TypeScript compiler out of its bundle and fetches
 * the pinned one on first use. The SDK has no bundle to keep small: it uses
 * the `typescript` package installed beside it, or `tsc` on PATH, and this
 * edition of the module never fetches anything.
 */

/** Whether this dawn fetches its compiler on first use: the SDK never does. */
export function fetchesTsc(): boolean {
  return false;
}

/** The compiler a fetch left behind: the SDK has none. */
export function fetchedTsc(): string | undefined {
  return undefined;
}

/** Fetches the compiler: the SDK does not. */
export async function fetchTsc(): Promise<string> {
  throw new Error("this dawn does not fetch a TypeScript compiler");
}
