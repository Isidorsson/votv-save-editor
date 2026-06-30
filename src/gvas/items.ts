// Inventory & equipment views over the GVAS tree.
//
// inventoryData = ArrayProperty<struct_save>; each element has a `class`
// (ObjectProperty item path) and a `key` (random id), plus nested per-item
// state arrays. equipment = ArrayProperty<struct_equipment>; each element wraps
// a `prop` (slot name + key) and a `data` struct_save (same shape as inventory).

import type {
  ArrayValue,
  GvasFile,
  Property,
  StructBody,
  Value,
} from "./gvas";

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

export function getContainer(file: GvasFile, name: ContainerView["name"]): ContainerView | null {
  const root = find(file.root, name);
  if (!root || root.value.kind !== "array" || root.value.value.kind !== "struct") return null;
  const arr: ArrayValue & { kind: "struct" } = root.value.value;

  const build = (): SlotItem[] =>
    arr.items.map((el, index) => {
      const ref = classRefOf(el, name);
      const classPath = ref?.kind === "object" ? ref.value : "";
      const keyProp = el.kind === "props" ? find(el.props, "key")?.value : undefined;
      return {
        index,
        classPath,
        label: slotLabel(el, name, classPath),
        key: keyProp?.kind === "name" ? keyProp.value : "",
        setClass(path: string) {
          if (ref?.kind === "object") ref.value = path;
        },
      };
    });

  const view: ContainerView = {
    name,
    items: build(),
    canAdd: arr.items.length > 0,
    add(classPath: string) {
      const template = arr.items[0];
      if (!template) return; // need a template element to clone a valid struct
      const clone = cloneBody(template);
      const key = newKey();
      rekey(clone, key);
      const ref = classRefOf(clone, name);
      if (ref?.kind === "object") ref.value = classPath;
      arr.items.push(clone);
      view.items = build();
    },
    remove(index: number) {
      arr.items.splice(index, 1);
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
