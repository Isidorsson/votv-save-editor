# VotV Save Editor

Browser-based editor for **Voices of the Void** `.sav` files (Unreal Engine 4.27
GVAS format). All parsing happens client-side — nothing is uploaded.

Saves live in `%localappdata%\VotV\Saved\SaveGames` (filenames start with `s_`).

## Run

```bash
bun install
bun run dev        # local dev server
bun run build      # static build -> dist/
```

## How it works

- `src/gvas/binary.ts` — little-endian reader/writer + Unreal FString encoding.
- `src/gvas/gvas.ts` — GVAS codec. Decodes the full tagged-property tree;
  interprets editable leaves (int/float/bool/str/name/object) and passes exotic
  values (TextProperty, native math structs) through as raw bytes sized by the
  tag's `Size` field, so they re-serialize verbatim.
- `src/gvas/edit.ts` — flattens the tree to editable leaves + curated field list.
- `src/gvas/items.ts` — inventory & equipment views: friendly item names from
  class paths, a harvested catalog of every item type in the save, and
  change/add/remove (clone a template element + fresh key).
- `src/app.ts` — UI: load, edit, item picker modal, verify, download.

## Safety contract

`bun run roundtrip` parses your real saves, re-serializes, and asserts the output
is **byte-identical** to the input. The writer is only trusted because it passes
this. On save, the app also re-parses its own output before letting you download;
if that fails, it refuses. **Still back up your original** (button in the UI).

## Dev scripts

- `scripts/roundtrip.ts` — byte-identity proof (the safety gate).
- `scripts/explore.ts` — dump scalar field paths/values from a save.
