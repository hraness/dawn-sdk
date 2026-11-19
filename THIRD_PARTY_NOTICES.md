# Third-party notices

The DAWN SDK's own sources are under the MIT License in `LICENSE`. The studio sounds under `assets/samples/studio/` are CC0-1.0. It bundles no third-party source. These are the packages it uses:

## @jitl/quickjs-wasmfile-release-sync 0.32.0

MIT. Copyright (c) Jake Teton-Landis and quickjs-emscripten authors; QuickJS Copyright (c) 2017-2021 Fabrice Bellard and Charlie Gordon.

Installed as a dependency: the QuickJS WebAssembly build that engine loads. Its licence text is in the package itself (`node_modules/@jitl/quickjs-wasmfile-release-sync/LICENSE`).

## quickjs-emscripten-core 0.32.0

MIT. Copyright (c) Jake Teton-Landis and quickjs-emscripten authors.

Installed as a dependency: the sealed engine that evaluates song source. Its licence text is in the package itself (`node_modules/quickjs-emscripten-core/LICENSE`).

## typescript

Apache-2.0. Copyright (c) Microsoft Corporation.

Not installed or bundled: `check` runs its `tsc` when one is installed; not bundled. Its licence text is in the package itself (`node_modules/typescript/LICENSE`).
