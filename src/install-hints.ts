/**
 * The one line that installs each outside tool a feature may need. DAWN never
 * installs them itself: a message that says a tool is missing ends with one of
 * these, so a Mac with only the DAWN app on it knows what to run.
 */
export const FFMPEG_HINT =
  "install ffmpeg: brew install ffmpeg (macOS, with Homebrew from https://brew.sh) or apt install ffmpeg (Debian/Ubuntu)";
/** uv's own installer needs neither Homebrew nor Python. */
export const UV_INSTALL = "curl -LsSf https://astral.sh/uv/install.sh | sh";
export const UV_HINT = `install uv: ${UV_INSTALL} (or brew install uv)`;
