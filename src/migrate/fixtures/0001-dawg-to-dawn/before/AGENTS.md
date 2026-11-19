# My notes

Keep the bass dry.

<!-- dawg:begin -->
# dawg project

This folder is a dawg song. dawg (the terminal DAW) and you edit the same
files; the open dawg window reloads when a file changes.

## Layout
- `song.ts`: tempo, meter, form and the track list (`export default song({...})`).
- `tracks/<slug>/track.ts`: one `track({...})` per track; samples in `tracks/<slug>/samples/`.
- Import the SDK as `import { song, track } from "dawg"` (vendored in `.dawg/sdk/v1.ts`).
- `.dawg/` is dawg's state (sessions, history.db, settings). Do not edit it by hand.

## Loop
1. Edit `song.ts` or `tracks/<slug>/track.ts`.
2. Run `dawg check`: typecheck and evaluate; exit 1 lists problems with file:line.
3. Watch `dawg history --follow` in another terminal to see each edit land as a revision.
   To be credited for an edit the open window already reloaded, name your files:
   `dawg check --as <you> --files tracks/bass/track.ts`.

## Dev mode
- The human runs `dawg dev` (or passes --dev): the same editor, plus `log` rows in history
  (file sync evaluations, typecheck results as file:line, rejected evaluations, tool args, errors).
- `dawg history --follow --kind log`: stream those rows; `--json` for one object per line.
- `dawg dev screen A`: print what dev pane A shows right now, as plain text.
- `dawg dev --reload`: for dawg's own source checkout; restarts the editor after each good change.

## History and comments
- `dawg history`: newest edits, undo/redo, comments and agent turns, one line each.
- Filter: `dawg history --track bass --kind comment`, `--bars 9-16`, `--param cutoff`,
  `--actor human`, `--tag love`, `--grep chorus`, `--since 1h`; `--json` for one object per line.
- `dawg history show <seq|id|rev:N>`: one row in full (ops, context).
- Leave a note for the human and the in-app agent: `dawg history comment "tightened the hats #groove"`.
- Read the human's comments before editing a part: they mark what to keep (#love) or change.

## Audio
- `dawg media chop --help`: info, onsets, beats, cut, slice, stretch, pitch, fades and more.
- `dawg media --help`: download, stems, analyze, notes (audio to MIDI), sample.
- Outputs are new 24-bit WAVs with a .json sidecar; inputs are never overwritten.

## More
- `dawg docs --agent`: the agent docs index (tool reference, recipes, guide notes).
- `dawg docs --agent <page>`, e.g. `dawg docs --agent recipe/chop-a-break`.
- DAWG.md in the dawg package is the full human manual.
<!-- dawg:end -->

More notes about dawg below the block.
