import { readGvas } from "../src/gvas/gvas";
import type { Property } from "../src/gvas/gvas";

const path = process.argv[2] ?? `${process.env.LOCALAPPDATA}/VotV/Saved/SaveGames/s_09Gaymer.sav`;
const file = readGvas(new Uint8Array(await Bun.file(path).arrayBuffer()));

interface Leaf { path: string; type: string; value: unknown }
const leaves: Leaf[] = [];

function base(name: string) { return name.replace(/_\d+_[0-9A-F]{32}$/, ""); }

function walk(props: Property[], prefix: string, depth: number) {
  for (const p of props) {
    const path = `${prefix}${base(p.name)}`;
    const v = p.value;
    if (v.kind === "int" || v.kind === "float" || v.kind === "bool" || v.kind === "str") {
      leaves.push({ path, type: v.kind, value: v.value });
    } else if (v.kind === "struct" && v.body.kind === "props" && depth < 6) {
      walk(v.body.props, `${path}.`, depth + 1);
    } else if (v.kind === "array" && v.value.kind === "struct" && depth < 4) {
      // only descend first element to learn shape
      const first = v.value.items[0];
      if (first && first.kind === "props") walk(first.props, `${path}[].`, depth + 1);
    }
  }
}
walk(file.root, "", 0);

console.log("ROOT PROPS:", file.root.map(p => `${base(p.name)}:${p.type}`).join(", "));
console.log("\n=== scalar leaves matching keywords ===");
const kw = /credit|money|cash|point|reward|day|date|time|sanity|health|upg_|process|score|name|player|level/i;
for (const l of leaves.filter(l => kw.test(l.path)).slice(0, 120)) {
  console.log(`${l.type.padEnd(5)} ${l.path} = ${JSON.stringify(l.value)}`);
}
console.log(`\ntotal scalar leaves: ${leaves.length}`);
