/**
 * The SDK renders with the reference TypeScript DSP only. DAWN can load an
 * optional native reverb kernel (its own prebuilt library) that produces the
 * same samples faster; the SDK ships no native code, so this edition of the
 * module never offers one and every render takes the reference path.
 */
export type ReverbKernel = (
  input: Float64Array,
  left: Float64Array,
  right: Float64Array,
  lengths: Uint32Array,
  gains: Float64Array,
  damp: number,
) => boolean;

export function nativeReverbKernel(): ReverbKernel | undefined {
  return undefined;
}
