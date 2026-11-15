/**
 * DAWN's studio library also holds sung hooks and vocal books. The SDK ships
 * only the library's generated sounds (`assets/samples/studio/`), so this
 * edition of the module lists no vocals.
 */
import type { BundledSample } from "./bundled-samples.ts";

/** In catalog order, after the generated sounds. */
export const BUNDLED_VOCALS: readonly BundledSample[] = [];
