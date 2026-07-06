// Inventory & equipment views over the GVAS tree.
//
// inventoryData = ArrayProperty<struct_save>; each element has a `class`
// (ObjectProperty item path) and a `key` (random id), plus nested per-item
// state arrays. equipment = ArrayProperty<struct_equipment>; each element wraps
// a `prop` (slot name + key) and a `data` struct_save (same shape as inventory).

import type {
  ArrayValue,
  GvasFile,
  MapEntryData,
  MapValue,
  Property,
  StructArrayHeader,
  StructBody,
  Value,
} from "./gvas";
import { ITEM_NAME_OVERRIDES, KNOWN_ITEM_BASES } from "./item-catalog";

const stripGuid = (name: string): string => name.replace(/_\d+_[0-9A-Fa-f]{32}$/, "");

function find(props: Property[], baseName: string): Property | undefined {
  return props.find((p) => stripGuid(p.name) === baseName);
}

// "/Game/objects/prop_equipment_flashlight.prop_equipment_flashlight_C" -> "Flashlight"
export function friendlyName(classPath: string): string {
  if (!classPath) return "(empty)";
  const last = classPath.split("/").pop() ?? classPath;
  let n = (last.split(".")[0] ?? last)
    .replace(/^prop_equipment_/, "")
    .replace(/^prop_/, "")
    .replace(/^actor_?/i, "")
    .replace(/_C$/, "")
    .replace(/_/g, " ")
    .trim();
  if (!n) n = last;
  return n.replace(/\b\w/g, (c) => c.toUpperCase());
}

// 22-char base64url id, matching the game's `key` style ("KSdAqoEoWkFJZCqIknlksQ").
function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/[+/=]/g, "").slice(0, 22);
}

// ---------------------------------------------------------------- catalog ----

export interface CatalogEntry {
  classPath: string;
  name: string;
}

// Every distinct `/Game/objects/...prop...` class path referenced anywhere in
// the save — the pool the picker searches.
export function harvestCatalog(file: GvasFile): CatalogEntry[] {
  const seen = new Set<string>();
  const visitValue = (v: Value): void => {
    if (v.kind === "object") {
      if (/^\/Game\/.*prop/i.test(v.value) || v.value.startsWith("/Game/objects/")) seen.add(v.value);
    } else if (v.kind === "struct" && v.body.kind === "props") {
      visitProps(v.body.props);
    } else if (v.kind === "array" && v.value.kind === "struct") {
      for (const item of v.value.items) if (item.kind === "props") visitProps(item.props);
    }
  };
  const visitProps = (props: Property[]): void => {
    for (const p of props) visitValue(p.value);
  };
  visitProps(file.root);
  return [...seen]
    .map((classPath) => ({ classPath, name: friendlyName(classPath) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The obtainable-item catalog: every known summonable prop plus anything this
// particular save happens to reference. Known entries win on name (so curated
// overrides show through), and save-only paths — grime, structural, npc,
// trigger props the known list omits — are still kept so nothing regresses.
const KNOWN_ITEMS: CatalogEntry[] = KNOWN_ITEM_BASES.map((base) => {
  const classPath = `/Game/objects/${base}.${base}_C`;
  return { classPath, name: ITEM_NAME_OVERRIDES[base] ?? friendlyName(classPath) };
});

export function buildCatalog(file: GvasFile): CatalogEntry[] {
  const byPath = new Map<string, CatalogEntry>();
  for (const e of KNOWN_ITEMS) byPath.set(e.classPath, e);
  for (const e of harvestCatalog(file)) if (!byPath.has(e.classPath)) byPath.set(e.classPath, e);
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- containers ----

export interface SlotItem {
  index: number;
  label: string;
  classPath: string;
  key: string;
  setClass(path: string): void;
}

export interface ContainerView {
  name: "inventoryData" | "equipment";
  items: SlotItem[];
  canAdd: boolean;
  add(classPath: string): void;
  remove(index: number): void;
}

function classRefOf(element: StructBody, container: ContainerView["name"]): Value | undefined {
  if (element.kind !== "props") return undefined;
  if (container === "inventoryData") return find(element.props, "class")?.value;
  const data = find(element.props, "data")?.value; // equipment: class lives under data
  if (data?.kind === "struct" && data.body.kind === "props") return find(data.body.props, "class")?.value;
  return undefined;
}

function slotLabel(element: StructBody, container: ContainerView["name"], classPath: string): string {
  if (container === "equipment" && element.kind === "props") {
    const prop = find(element.props, "prop")?.value;
    if (prop?.kind === "struct" && prop.body.kind === "props") {
      const nm = find(prop.body.props, "name")?.value;
      if (nm?.kind === "name" && nm.value && nm.value !== "None") return friendlyName(nm.value);
    }
  }
  return friendlyName(classPath);
}

// Assigns a fresh key to every NameProperty named "key" in a cloned element so
// the new item doesn't collide with the one it was cloned from.
function rekey(element: StructBody, key: string): void {
  if (element.kind !== "props") return;
  for (const p of element.props) {
    const v = p.value;
    if (stripGuid(p.name) === "key" && v.kind === "name") v.value = key;
    else if (v.kind === "struct" && v.body.kind === "props") rekey({ kind: "props", props: v.body.props }, key);
  }
}

// ------------------------------------------------------------- GObjStack sync ----

// The player's carried inventory is stored redundantly in TWO structures that
// must agree: `inventoryData` (the flat list this view edits) and one entry of
// `GObjStack` — the stack the game actually loads into the inventory on load.
// Adding an item to inventoryData alone leaves it unregistered, so it never
// appears in game. We locate the player's GObjStack entry as the one whose item
// keys overlap inventoryData (item keys are globally unique, so it's
// unambiguous) and mirror every add/remove/class-change into it. A fresh/empty
// inventory finds no stack, and we fall back to editing inventoryData alone.

function keyOf(el: StructBody | undefined): string {
  if (!el || el.kind !== "props") return "";
  const k = find(el.props, "key")?.value;
  return k?.kind === "name" ? k.value : "";
}

function gobjStackItems(entry: StructBody): StructBody[] | null {
  if (entry.kind !== "props") return null;
  const obj = find(entry.props, "obj")?.value;
  return obj?.kind === "array" && obj.value.kind === "struct" ? obj.value.items : null;
}

function findPlayerStack(file: GvasFile, invItems: StructBody[]): StructBody[] | null {
  const gv = find(file.root, "GObjStack")?.value;
  if (!gv || gv.kind !== "array" || gv.value.kind !== "struct") return null;
  const invKeys = new Set(invItems.map(keyOf).filter(Boolean));
  if (!invKeys.size) return null;
  let best: StructBody[] | null = null;
  let bestOverlap = 0;
  for (const entry of gv.value.items) {
    const items = gobjStackItems(entry);
    if (!items) continue;
    const overlap = items.reduce((n, el) => n + (invKeys.has(keyOf(el)) ? 1 : 0), 0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = items;
    }
  }
  return best;
}

function syncStackClass(items: StructBody[], key: string, classPath: string): void {
  const el = items.find((e) => keyOf(e) === key);
  if (el && el.kind === "props") {
    const ref = find(el.props, "class")?.value;
    if (ref?.kind === "object") ref.value = classPath;
  }
}

function removeFromStack(items: StructBody[], key: string): void {
  const i = items.findIndex((e) => keyOf(e) === key);
  if (i >= 0) items.splice(i, 1);
}

// A struct_save's blueprint class lives in its top-level `class` ObjectProperty.
function topClass(el: StructBody): string {
  if (el.kind !== "props") return "";
  const c = find(el.props, "class")?.value;
  return c?.kind === "object" ? c.value : "";
}

// The right template for a new inventory item is a REAL one of the same class:
// each item carries per-type state — an internal item tag (e.g. beer→"beer_c",
// screwdriver→"tool_sc") plus saved variables — that must match its class or the
// game won't render it. Cloning an arbitrary slot and only swapping the class
// leaves that state mismatched. Search the inventory, then the world objects,
// then the object stacks. Returns null when the class exists nowhere in the save
// (e.g. an item never obtained), in which case the caller falls back to a
// generic clone that may not display in game.
function findInventoryTemplate(file: GvasFile, items: StructBody[], classPath: string): StructBody | null {
  const match = (el: StructBody): boolean => topClass(el) === classPath;

  const inInventory = items.find(match);
  if (inInventory) return inInventory;

  const od = find(file.root, "objectsData")?.value;
  if (od?.kind === "array" && od.value.kind === "struct") {
    const hit = od.value.items.find(match);
    if (hit) return hit;
  }

  const gv = find(file.root, "GObjStack")?.value;
  if (gv?.kind === "array" && gv.value.kind === "struct") {
    for (const entry of gv.value.items) {
      const hit = gobjStackItems(entry)?.find(match);
      if (hit) return hit;
    }
  }
  return null;
}

// Any struct_save in the save, used as a last-resort template so items can be
// added to an EMPTY inventory — which has no slot of its own to clone from.
// Objects and stacks are always populated in a real save, so this rarely fails.
function anyItemTemplate(file: GvasFile): StructBody | null {
  const od = find(file.root, "objectsData")?.value;
  if (od?.kind === "array" && od.value.kind === "struct" && od.value.items[0]) return od.value.items[0];

  const gv = find(file.root, "GObjStack")?.value;
  if (gv?.kind === "array" && gv.value.kind === "struct") {
    for (const entry of gv.value.items) {
      const items = gobjStackItems(entry);
      if (items && items[0]) return items[0];
    }
  }
  return null;
}

// A fresh, empty StructProperty array. The inner tag (structType + guid) is
// cloned from any existing array of the same struct type in the save — the guid
// is keyed on the struct type, so this yields the exact header the game writes
// for this container. Returns null when the save has no such array to borrow a
// valid header from (e.g. the stats-only data.sav).
function makeEmptyStructArray(file: GvasFile, name: string, structType: string): Property | null {
  const tmpl = file.root.find(
    (p) =>
      p.value.kind === "array" &&
      p.value.value.kind === "struct" &&
      p.value.value.header.structType === structType,
  );
  if (!tmpl || tmpl.value.kind !== "array" || tmpl.value.value.kind !== "struct") return null;
  const src = tmpl.value.value.header;
  const header: StructArrayHeader = {
    propName: name,
    propType: src.propType,
    arrayIndex: src.arrayIndex,
    structType,
    guid: src.guid.slice(),
    guidFlag: src.guidFlag,
  };
  return {
    name,
    type: "ArrayProperty",
    arrayIndex: 0,
    guidFlag: 0,
    value: { kind: "array", innerType: "StructProperty", value: { kind: "struct", header, items: [] } },
  };
}

// inventoryData naturally precedes objectsData in the save layout; slot a
// synthesized property there. Order is cosmetic (properties are name-tagged),
// but this keeps the layout matching a save the game wrote itself.
function insertBeforeObjects(file: GvasFile, prop: Property): void {
  const at = file.root.findIndex((p) => stripGuid(p.name) === "objectsData");
  if (at >= 0) file.root.splice(at, 0, prop);
  else file.root.push(prop);
}

export function getContainer(file: GvasFile, name: ContainerView["name"]): ContainerView | null {
  // The game omits inventoryData entirely while the player carries nothing, which
  // would hide the whole section and its "add" button. Synthesize an empty
  // struct_save array so it still renders and can be added to; the property is
  // only spliced into the save on the first add (see `attach`), so an untouched
  // save stays byte-identical. Equipment and other absent containers keep the
  // old behavior of returning null.
  const existing = find(file.root, name);
  let attach: (() => void) | null = null;
  let prop: Property;
  if (existing) {
    if (existing.value.kind !== "array" || existing.value.value.kind !== "struct") return null;
    prop = existing;
  } else {
    const synth = name === "inventoryData" ? makeEmptyStructArray(file, name, "struct_save") : null;
    if (!synth) return null;
    prop = synth;
    attach = () => {
      if (!find(file.root, name)) insertBeforeObjects(file, synth);
    };
  }
  if (prop.value.kind !== "array" || prop.value.value.kind !== "struct") return null;
  const arr: ArrayValue & { kind: "struct" } = prop.value.value;

  // Inventory items are mirrored into the player's GObjStack entry; equipment isn't.
  const mirror = name === "inventoryData" ? findPlayerStack(file, arr.items) : null;

  // Template for brand-new items. A non-empty container clones its own first
  // slot; an empty inventory has nothing to clone, so fall back to any item in
  // the save. Without this an emptied inventory can never be added to again.
  const fallbackTemplate: StructBody | null =
    name === "inventoryData" ? (arr.items[0] ?? anyItemTemplate(file)) : (arr.items[0] ?? null);

  const build = (): SlotItem[] =>
    arr.items.map((el, index) => {
      const ref = classRefOf(el, name);
      const classPath = ref?.kind === "object" ? ref.value : "";
      const keyProp = el.kind === "props" ? find(el.props, "key")?.value : undefined;
      const key = keyProp?.kind === "name" ? keyProp.value : "";
      return {
        index,
        classPath,
        label: slotLabel(el, name, classPath),
        key,
        setClass(path: string) {
          if (ref?.kind === "object") ref.value = path;
          if (mirror && key) syncStackClass(mirror, key, path);
        },
      };
    });

  const view: ContainerView = {
    name,
    items: build(),
    canAdd: !!fallbackTemplate,
    add(classPath: string) {
      // Prefer a real same-class item as the template so per-type state (item
      // tag, saved variables) matches the class; fall back to any item otherwise.
      const template =
        (name === "inventoryData" ? findInventoryTemplate(file, arr.items, classPath) : null) ??
        fallbackTemplate;
      if (!template) return; // need a template element to clone a valid struct
      const clone = cloneBody(template);
      const key = newKey();
      rekey(clone, key);
      const ref = classRefOf(clone, name);
      if (ref?.kind === "object") ref.value = classPath;
      attach?.(); // create inventoryData in the save the first time it gains an item
      arr.items.push(clone);
      if (mirror) mirror.push(cloneBody(clone)); // identical twin, same key + class
      view.items = build();
    },
    remove(index: number) {
      const key = keyOf(arr.items[index]);
      arr.items.splice(index, 1);
      if (mirror && key) removeFromStack(mirror, key);
      view.items = build();
    },
  };
  return view;
}

// ------------------------------------------------------------- deep clone ----

function cloneBody(b: StructBody): StructBody {
  return b.kind === "native"
    ? { kind: "native", bytes: b.bytes.slice() }
    : { kind: "props", props: b.props.map(cloneProp) };
}

function cloneArray(a: ArrayValue): ArrayValue {
  if (a.kind === "primitive") {
    return { kind: "primitive", innerType: a.innerType, items: [...a.items], byteAsName: a.byteAsName };
  }
  return {
    kind: "struct",
    header: { ...a.header, guid: a.header.guid.slice() },
    items: a.items.map(cloneBody),
  };
}

function cloneMapEntry(d: MapEntryData): MapEntryData {
  return d.kind === "struct" ? { kind: "struct", body: cloneBody(d.body) } : { ...d };
}

function cloneMap(m: MapValue): MapValue {
  return {
    numKeysToRemove: m.numKeysToRemove,
    entries: m.entries.map((e) => ({ key: cloneMapEntry(e.key), value: cloneMapEntry(e.value) })),
  };
}

function cloneValue(v: Value): Value {
  switch (v.kind) {
    case "int":
    case "float":
    case "bool":
    case "str":
    case "name":
    case "object":
      return { ...v };
    case "byte":
      return { kind: "byte", enumName: v.enumName, bytes: v.bytes.slice() };
    case "opaque":
      return { kind: "opaque", bytes: v.bytes.slice() };
    case "struct":
      return { kind: "struct", structType: v.structType, structGuid: v.structGuid.slice(), body: cloneBody(v.body) };
    case "array":
      return { kind: "array", innerType: v.innerType, value: cloneArray(v.value) };
    case "map":
      return { kind: "map", keyType: v.keyType, valueType: v.valueType, value: cloneMap(v.value) };
  }
}

function cloneProp(p: Property): Property {
  return {
    name: p.name,
    type: p.type,
    arrayIndex: p.arrayIndex,
    guidFlag: p.guidFlag,
    guid: p.guid?.slice(),
    value: cloneValue(p.value),
  };
}
