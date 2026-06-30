// Turns a parsed GVAS tree into a flat list of editable scalar leaves, each
// holding a live get/set over the underlying Value object. Mutating a leaf
// mutates the tree in place, so writeGvas() then emits the edited save.

import type { GvasFile, Property, Value } from "./gvas";

export type ScalarKind = "int" | "float" | "bool" | "str";

export interface ScalarLeaf {
  path: string; // dotted, GUID suffixes stripped (e.g. "upgrades.upg_processLvl")
  kind: ScalarKind;
  get(): number | boolean | string;
  set(v: number | boolean | string): void;
}

// Struct-arrays bigger than this aren't expanded into per-element leaves — the
// signal list alone holds ~10k entries and would swamp the UI. Curated fields
// (Points, upgrades, Day, survival stats) all live shallow, so nothing useful
// is lost.
const MAX_ARRAY_EXPAND = 32;

const stripGuid = (name: string): string => name.replace(/_\d+_[0-9A-Fa-f]{32}$/, "");

function leafFor(path: string, v: Value): ScalarLeaf | null {
  switch (v.kind) {
    case "int":
    case "float":
      return { path, kind: v.kind, get: () => v.value, set: (n) => (v.value = Number(n)) };
    case "bool":
      return { path, kind: "bool", get: () => v.value, set: (n) => (v.value = Boolean(n)) };
    case "str":
    case "name":
    case "object":
      return { path, kind: "str", get: () => v.value, set: (n) => (v.value = String(n)) };
    default:
      return null;
  }
}

function walk(props: Property[], prefix: string, out: ScalarLeaf[]): void {
  for (const p of props) {
    const path = prefix + stripGuid(p.name);
    const v = p.value;
    const leaf = leafFor(path, v);
    if (leaf) {
      out.push(leaf);
      continue;
    }
    if (v.kind === "struct" && v.body.kind === "props") {
      walk(v.body.props, path + ".", out);
    } else if (
      v.kind === "array" &&
      v.value.kind === "struct" &&
      v.value.items.length <= MAX_ARRAY_EXPAND
    ) {
      v.value.items.forEach((item, i) => {
        if (item.kind === "props") walk(item.props, `${path}[${i}].`, out);
      });
    }
  }
}

export function collectLeaves(file: GvasFile): ScalarLeaf[] {
  const out: ScalarLeaf[] = [];
  walk(file.root, "", out);
  return out;
}

// Curated high-value fields, grouped into sections. Fields missing from a given
// save are skipped at render time.
export interface FieldDef {
  path: string;
  label: string;
  hint?: string;
}
export interface FieldGroup {
  id: string;
  title: string;
  fields: FieldDef[];
}

export const FIELD_GROUPS: FieldGroup[] = [
  {
    id: "resources",
    title: "Resources",
    fields: [
      { path: "Points", label: "Points", hint: "in-game currency" },
      { path: "Day", label: "Day", hint: "day / time counter" },
      { path: "food", label: "Food", hint: "hunger meter" },
      { path: "sleep", label: "Sleep", hint: "rest meter" },
      { path: "battery", label: "Suit battery" },
      { path: "moonPhase", label: "Moon phase" },
      { path: "totalTime", label: "Total playtime", hint: "seconds" },
    ],
  },
  {
    id: "upgrades",
    title: "Workstation upgrades",
    fields: [
      { path: "upgrades.upg_processLvl", label: "Signal processing level" },
      { path: "upgrades.upg_processSpeed", label: "Processing speed" },
      { path: "upgrades.upg_downloadSpd", label: "Download speed" },
      { path: "upgrades.upg_detecQual", label: "Detection quality" },
      { path: "upgrades.upg_scanner", label: "Scanner range" },
      { path: "upgrades.upg_scannerFr", label: "Scanner frequency" },
      { path: "upgrades.upg_radarHist", label: "Radar history" },
      { path: "upgrades.upg_radar_speed", label: "Radar speed" },
      { path: "upgrades.upg_compTime", label: "Computation time" },
      { path: "upgrades.upg_triangleProb", label: "Triangulation odds" },
      { path: "upgrades.upg_coordDrift", label: "Coordinate drift" },
      { path: "upgrades.upg_coordPingSpeed", label: "Coord ping speed" },
      { path: "upgrades.upg_coordMovementSpeed", label: "Coord move speed" },
      { path: "upgrades.upg_coordRadarSpeed", label: "Coord radar speed" },
      { path: "upgrades.upg_coordCooldown", label: "Coord cooldown" },
    ],
  },
  // data.sav (global save) groups — Stats are lifetime counters, Settings are options.
  {
    id: "stats",
    title: "Lifetime stats",
    fields: [
      { path: "Stats.total_points", label: "Total points earned" },
      { path: "Stats.points_spent", label: "Points spent" },
      { path: "Stats.signals_found", label: "Signals found" },
      { path: "Stats.days_total", label: "Days total" },
      { path: "Stats.food_eaten", label: "Food eaten" },
      { path: "Stats.items_bought", label: "Items bought" },
      { path: "Stats.total_playtime", label: "Total playtime", hint: "seconds" },
      { path: "Stats.distance_walked", label: "Distance walked" },
      { path: "Stats.total_jumps", label: "Total jumps" },
      { path: "Stats.servers_repaired", label: "Servers repaired" },
      { path: "Stats.sleep_time", label: "Sleep time", hint: "seconds" },
      { path: "Stats.save_count", label: "Save count" },
      { path: "Stats.toilet_uses", label: "Toilet uses" },
      { path: "Stats.steps", label: "Steps taken" },
      { path: "Stats.total_dreams", label: "Total dreams" },
      { path: "Stats.object_broken", label: "Objects broken" },
      { path: "Stats.falls", label: "Falls" },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    fields: [
      { path: "Settings.M_fps", label: "FPS cap" },
      { path: "Settings.headbobStr", label: "Head bob strength" },
      { path: "Settings.headbobTilt", label: "Head bob tilt" },
      { path: "Settings.viewmodel_bobbing", label: "Viewmodel bobbing" },
      { path: "Settings.doorHeadImpact", label: "Door head impact" },
    ],
  },
];

// Groups rendered with the level-bar control (others use plain field rows).
export const BAR_GROUP_IDS = new Set(["upgrades"]);

// coerceInput parses what the user typed into a value safe to store for the
// leaf's kind. Policy: REJECT invalid input (mark the field, log the reason)
// rather than silently clamp — never write a value that could corrupt the save.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export type EditResult =
  | { ok: true; value: number | boolean | string }
  | { ok: false; error: string };

export function coerceInput(raw: string, kind: ScalarKind): EditResult {
  switch (kind) {
    case "int": {
      const t = raw.trim();
      if (!/^[-+]?\d+$/.test(t)) return { ok: false, error: `"${raw}" is not a whole number` };
      const n = Number(t);
      if (n < INT32_MIN || n > INT32_MAX)
        return { ok: false, error: `${n} is outside int32 range (±2,147,483,647)` };
      return { ok: true, value: n };
    }
    case "float": {
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) return { ok: false, error: `"${raw}" is not a finite number` };
      return { ok: true, value: n };
    }
    case "bool": {
      const t = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(t)) return { ok: true, value: true };
      if (["false", "0", "no", "n", ""].includes(t)) return { ok: true, value: false };
      return { ok: false, error: `"${raw}" is not true/false` };
    }
    case "str":
      return { ok: true, value: raw };
  }
}
