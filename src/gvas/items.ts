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
  /** Set when the saved item id contradicts the class — the game will show a different item. */
  warn?: string;
  setClass(path: string): void;
}

export interface ContainerView {
  name: "inventoryData" | "equipment";
  items: SlotItem[];
  canAdd: boolean;
  /** Returns true when a same-class donor supplied the item state (correct in-game identity). */
  add(classPath: string): boolean;
  duplicate(index: number): void;
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
// must agree: `inventoryData` (the flat list this view edits) and the first
// entry of `GObjStack` — `GObjStack[0].obj`, the stack the game actually loads
// into the inventory on load. The two are exact deep-clone twins (same items,
// same order). Editing inventoryData alone leaves the item unregistered, so it
// never appears in game; every edit is mirrored into the stack to keep the twins
// identical. When the inventory already has items we confirm the stack by
// key-overlap (item keys are globally unique); an empty or drifted inventory
// falls back to the first stack, which is always the player's.

function keyOf(el: StructBody | undefined): string {
  if (!el || el.kind !== "props") return "";
  const k = find(el.props, "key")?.value;
  return k?.kind === "name" ? k.value : "";
}

function gobjStackItems(entry: StructBody | undefined): StructBody[] | null {
  if (!entry || entry.kind !== "props") return null;
  const obj = find(entry.props, "obj")?.value;
  return obj?.kind === "array" && obj.value.kind === "struct" ? obj.value.items : null;
}

function findPlayerStack(file: GvasFile, invItems: StructBody[]): StructBody[] | null {
  const gv = find(file.root, "GObjStack")?.value;
  if (!gv || gv.kind !== "array" || gv.value.kind !== "struct") return null;

  // With items present, key-overlap pins the stack unambiguously.
  const invKeys = new Set(invItems.map(keyOf).filter(Boolean));
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
  if (best) return best;

  // No overlap — an empty inventory (no keys) or one that drifted from its stack
  // (e.g. items added before this mirroring existed). The player's carried
  // inventory is always the first GObjStack entry, so fall back to it; syncing it
  // is what makes added items load in game and repairs the drift.
  return gobjStackItems(gv.value.items[0]);
}

// A struct_save's blueprint class lives in its top-level `class` ObjectProperty.
function topClass(el: StructBody): string {
  if (el.kind !== "props") return "";
  const c = find(el.props, "class")?.value;
  return c?.kind === "object" ? c.value : "";
}

// The saved item id — first entry of the names[0] batch (e.g. "tool_sc" for a
// screwdriver, "beer_c" for beer) — is the identity the game's inventory
// actually shows. The class alone doesn't decide it: the generic prop class
// carries hundreds of different ids, and the id is not derivable from the
// class name, so it can only be copied from a real donor item.
function itemIdOf(el: StructBody): string {
  if (el.kind !== "props") return "";
  const names = find(el.props, "names")?.value;
  if (names?.kind !== "array" || names.value.kind !== "struct") return "";
  const first = names.value.items[0];
  if (!first || first.kind !== "props") return "";
  const batch = first.props[0]?.value;
  if (batch?.kind !== "array" || batch.value.kind !== "primitive") return "";
  const id = batch.value.items[0];
  return typeof id === "string" ? id : "";
}

// Every game-authored struct_save in the world: objectsData plus all GObjStack
// entries EXCEPT the player's own stack (`skip`). The player stack mirrors
// inventoryData and is written by this editor, so treating it as evidence
// would launder editor-made items into "the game says so".
function eachWorldSave(file: GvasFile, skip: StructBody[] | null, fn: (el: StructBody) => void): void {
  const od = find(file.root, "objectsData")?.value;
  if (od?.kind === "array" && od.value.kind === "struct") for (const el of od.value.items) fn(el);
  const gv = find(file.root, "GObjStack")?.value;
  if (gv?.kind === "array" && gv.value.kind === "struct") {
    for (const entry of gv.value.items) {
      const items = gobjStackItems(entry);
      if (!items || items === skip) continue;
      for (const el of items) fn(el);
    }
  }
}

function inventoryItems(file: GvasFile): StructBody[] {
  const inv = find(file.root, "inventoryData")?.value;
  return inv?.kind === "array" && inv.value.kind === "struct" ? inv.value.items : [];
}

// Classes that have a clean donor item somewhere in the save — the ones the
// picker can add with a correct in-game identity. Inventory rows count only
// when their id doesn't contradict the class (see idMismatch).
export function donorClasses(file: GvasFile): Set<string> {
  const invItems = inventoryItems(file);
  const mirror = findPlayerStack(file, invItems);
  const authored = collectAuthoredIds(file, mirror);
  const s = new Set(authored.byClass.keys());
  for (const el of invItems) {
    const c = topClass(el);
    if (c && !idMismatch(authored, el, c)) s.add(c);
  }
  return s;
}

// Game-authored id evidence: class -> its distinct ids, and id -> the classes
// that legitimately carry it. Used to flag inventory rows whose id contradicts
// their class. Only single-id classes are conclusive per-class — the generic
// prop class legitimately maps to hundreds of ids.
interface AuthoredIds {
  byClass: Map<string, Set<string>>;
  byId: Map<string, Set<string>>;
}

function collectAuthoredIds(file: GvasFile, skip: StructBody[] | null): AuthoredIds {
  const byClass = new Map<string, Set<string>>();
  const byId = new Map<string, Set<string>>();
  eachWorldSave(file, skip, (el) => {
    const cls = topClass(el);
    const id = itemIdOf(el);
    if (!cls || !id) return;
    let ids = byClass.get(cls);
    if (!ids) byClass.set(cls, (ids = new Set()));
    ids.add(id);
    let owners = byId.get(id);
    if (!owners) byId.set(id, (owners = new Set()));
    owners.add(cls);
  });
  return { byClass, byId };
}

// The conclusive wrong-identity checks. A row renders as a different item in
// game when the game saved this class with exactly one id and the row's id
// differs, or when the class has no game-authored donor at all yet the row's
// id is owned by another class (a donor-less add that cloned a foreign item).
function idMismatch(authored: AuthoredIds, el: StructBody, classPath: string): string | undefined {
  const id = itemIdOf(el);
  if (!id) return undefined;
  const ids = authored.byClass.get(classPath);
  if (ids?.size === 1 && !ids.has(id)) {
    return `Saved id "${id}" doesn't match this class (the game uses "${[...ids][0]}"), so in game it appears as a different item. Remove this row and re-add the item.`;
  }
  if (!ids) {
    const owners = authored.byId.get(id);
    if (owners && !owners.has(classPath)) {
      return `Saved id "${id}" belongs to a different item, so in game this row appears as that item instead. Remove the row and re-add once the real item exists in the save.`;
    }
  }
  return undefined;
}

// The right template for a new inventory item is a REAL one of the same class:
// each item carries per-type state — the item id above plus saved variables —
// that must match its class or the game shows the donor's item instead.
// World donors are searched before the inventory, and inventory rows with a
// contradicting id are never used, so editor-created impostors don't poison
// future adds. Returns null when the class has no clean donor anywhere (e.g.
// an item never obtained), in which case the caller falls back to a generic
// clone and reports the mismatch.
function findInventoryTemplate(
  file: GvasFile,
  items: StructBody[],
  classPath: string,
  mirror: StructBody[] | null,
  authored: AuthoredIds,
): StructBody | null {
  const match = (el: StructBody): boolean => topClass(el) === classPath;

  let hit: StructBody | null = null;
  eachWorldSave(file, mirror, (el) => {
    if (!hit && match(el)) hit = el;
  });
  return hit ?? items.find((el) => match(el) && !idMismatch(authored, el, classPath)) ?? null;
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

  // Rebuild the stack as an exact deep-clone twin of inventoryData after every
  // edit. Full rebuild (rather than an incremental push/splice) keeps the two in
  // lockstep and self-heals a save whose copies had drifted — e.g. items added
  // before this mirroring existed, which is why they never loaded in game.
  const syncMirror = (): void => {
    if (!mirror) return;
    mirror.length = 0;
    for (const el of arr.items) mirror.push(cloneBody(el));
  };

  // Template for brand-new items. A non-empty container clones its own first
  // slot; an empty inventory has nothing to clone, so fall back to any item in
  // the save. Without this an emptied inventory can never be added to again.
  const fallbackTemplate: StructBody | null =
    name === "inventoryData" ? (arr.items[0] ?? anyItemTemplate(file)) : (arr.items[0] ?? null);

  // Wrong-identity evidence, excluding the player's own (editor-written) stack
  // so impostor rows can't vouch for themselves. See idMismatch.
  const authored = name === "inventoryData" ? collectAuthoredIds(file, mirror) : null;
  const warnOf = (el: StructBody, classPath: string): string | undefined =>
    authored && classPath ? idMismatch(authored, el, classPath) : undefined;

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
        warn: warnOf(el, classPath),
        setClass(path: string) {
          if (ref?.kind === "object") ref.value = path;
          syncMirror();
        },
      };
    });

  const view: ContainerView = {
    name,
    items: build(),
    canAdd: !!fallbackTemplate,
    add(classPath: string) {
      // Prefer a real same-class item as the template so per-type state (item
      // id, saved variables) matches the class; fall back to any item otherwise.
      // Equipment elements are struct_equipment, so their only donors are other
      // slots of the same container.
      const sameClassSlot = arr.items.find((el) => {
        const r = classRefOf(el, name);
        return r?.kind === "object" && r.value === classPath;
      });
      const template =
        (authored ? findInventoryTemplate(file, arr.items, classPath, mirror, authored) : sameClassSlot) ??
        fallbackTemplate;
      if (!template) return false; // need a template element to clone a valid struct
      const srcRef = classRefOf(template, name);
      const exact = srcRef?.kind === "object" && srcRef.value === classPath;
      const clone = cloneBody(template);
      const key = newKey();
      rekey(clone, key);
      const ref = classRefOf(clone, name);
      if (ref?.kind === "object") ref.value = classPath;
      attach?.(); // create inventoryData in the save the first time it gains an item
      arr.items.push(clone);
      syncMirror(); // keep GObjStack[0].obj an identical twin so the item loads in game
      view.items = build();
      return exact;
    },
    // Exact clone of an existing slot (same class, same per-item state) with a
    // fresh key — the safest way to get multiples of an item.
    duplicate(index: number) {
      const src = arr.items[index];
      if (!src) return;
      const clone = cloneBody(src);
      rekey(clone, newKey());
      arr.items.splice(index + 1, 0, clone);
      syncMirror();
      view.items = build();
    },
    remove(index: number) {
      arr.items.splice(index, 1);
      syncMirror();
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
