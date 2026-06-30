// Proof harness: read a real .sav, re-serialize, assert byte-identical.
// Run: bun run scripts/roundtrip.ts [path-to-sav ...]
import { readGvas, writeGvas } from "../src/gvas/gvas";

const DEFAULTS = [
  `${process.env.LOCALAPPDATA}/VotV/Saved/SaveGames/data.sav`,
  `${process.env.LOCALAPPDATA}/VotV/Saved/SaveGames/s_09Gaymer.sav`,
];

const targets = process.argv.length > 2 ? process.argv.slice(2) : DEFAULTS;

function hex(bytes: Uint8Array, at: number, span = 16): string {
  const start = Math.max(0, at - span);
  const end = Math.min(bytes.length, at + span);
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    const mark = i === at ? "[" : "";
    parts.push(`${mark}${bytes[i]!.toString(16).padStart(2, "0")}`);
  }
  return parts.join(" ");
}

let allOk = true;
for (const path of targets) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.log(`SKIP  ${path} (not found)`);
    continue;
  }
  const original = new Uint8Array(await file.arrayBuffer());
  try {
    const parsed = readGvas(original);
    const out = writeGvas(parsed);
    if (out.length !== original.length) {
      allOk = false;
      console.log(`FAIL  ${path}  length ${original.length} -> ${out.length}`);
    }
    let diff = -1;
    const n = Math.min(out.length, original.length);
    for (let i = 0; i < n; i++) {
      if (out[i] !== original[i]) {
        diff = i;
        break;
      }
    }
    if (diff === -1 && out.length === original.length) {
      console.log(`OK    ${path}  (${original.length} bytes, ${parsed.root.length} root props)`);
    } else {
      allOk = false;
      console.log(`FAIL  ${path}  first diff at byte ${diff}`);
      console.log(`  orig: ${hex(original, diff)}`);
      console.log(`  ours: ${hex(out, diff)}`);
    }
  } catch (e) {
    allOk = false;
    console.log(`ERROR ${path}  ${(e as Error).message}`);
    console.log((e as Error).stack);
  }
}

process.exit(allOk ? 0 : 1);
