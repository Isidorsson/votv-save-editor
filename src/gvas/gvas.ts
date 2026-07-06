// GVAS (Unreal Engine 4.27 SaveGame) codec for Voices of the Void saves.
//
// Strategy: fully decode the tagged-property *tree* (names, types, nesting) so
// every value is navigable, but interpret only the leaf types players edit
// (Int/Float/Bool/Str/Name/Object). Exotic values (TextProperty, native math
// structs like Vector/Quat) are kept as raw bytes sized by the tag's `Size`
// field, so they re-serialize verbatim. The header and any trailing bytes are
// also preserved raw. Correctness is proven by a byte-identical round-trip.

import { BinaryReader, BinaryWriter } from "./binary";

// Native (C++ USTRUCT) structs serialized as raw bytes rather than a tagged
// property list. Sizes are needed to read them as array elements (where no
// per-element Size tag exists). UE 4.27 uses 32-bit floats for these.
const NATIVE_STRUCT_SIZE: Record<string, number> = {
  Vector: 12,
  Rotator: 12,
  Quat: 16,
  Vector2D: 8,
  IntPoint: 8,
  LinearColor: 16,
  Color: 4,
  Guid: 16,
  DateTime: 8,
  Timespan: 8,
  Vector4: 16,
  IntVector: 12,
};

export type Scalar = number | boolean | string;

export type StructBody =
  | { kind: "native"; bytes: Uint8Array }
  | { kind: "props"; props: Property[] };

export type ArrayValue =
  | { kind: "primitive"; innerType: string; items: Scalar[]; byteAsName?: boolean }
  | {
      kind: "struct";
      header: StructArrayHeader;
      items: StructBody[];
    };

export interface StructArrayHeader {
  propName: string;
  propType: string; // always "StructProperty"
  arrayIndex: number; // inner tag ArrayIndex, normally 0
  structType: string;
  guid: Uint8Array; // 16 bytes
  guidFlag: number; // trailing byte, normally 0
}

// One key or value inside a MapProperty. Keys/values are serialized as bare
// values (no per-entry tag): primitives per their inner type, or a struct as a
// bare property list. Byte keys/values are enum FNames (fstring), handled in
// readMapEntry/writeMapEntry.
export type MapEntryData =
  | { kind: "primitive"; value: Scalar }
  | { kind: "struct"; body: StructBody };

export interface MapEntry {
  key: MapEntryData;
  value: MapEntryData;
}

export interface MapValue {
  numKeysToRemove: number; // leading int32, normally 0
  entries: MapEntry[];
}

export type Value =
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "str"; value: string }
  | { kind: "name"; value: string }
  | { kind: "object"; value: string }
  | { kind: "byte"; enumName: string; bytes: Uint8Array }
  | { kind: "struct"; structType: string; structGuid: Uint8Array; body: StructBody }
  | { kind: "array"; innerType: string; value: ArrayValue }
  | { kind: "map"; keyType: string; valueType: string; value: MapValue }
  | { kind: "opaque"; bytes: Uint8Array };

export interface Property {
  name: string;
  type: string;
  arrayIndex: number;
  guidFlag: number;
  guid?: Uint8Array;
  value: Value;
}

export interface GvasFile {
  header: Uint8Array; // raw, from "GVAS" through SaveGameClassName
  root: Property[];
  trailer: Uint8Array; // raw bytes after the terminating "None"
}

// ---------------------------------------------------------------- reading ----

export function readGvas(bytes: Uint8Array): GvasFile {
  const r = new BinaryReader(bytes);
  skipHeader(r);
  const header = bytes.subarray(0, r.pos);
  const root = readPropertyList(r);
  const trailer = bytes.subarray(r.pos);
  return { header, root, trailer };
}

// A props-kind struct element (e.g. one struct_save item) is self-contained: a
// tagged property list ending in "None". These serialize one element to bytes
// and back, so authored item state can be stored outside a save (item-templates).
export function encodeStructBody(body: StructBody): Uint8Array {
  const w = new BinaryWriter();
  writeStructBody(w, body);
  return w.finish();
}

export function decodeStructBody(bytes: Uint8Array): StructBody {
  return readStructBody(new BinaryReader(bytes), "", bytes.length);
}

function skipHeader(r: BinaryReader): void {
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== "GVAS") throw new Error(`not a GVAS file (magic=${magic})`);
  r.i32(); // SaveGameFileVersion
  r.i32(); // PackageFileUE4Version
  r.u8(); r.u8(); // EngineVersion major (u16)
  r.u8(); r.u8(); // minor (u16)
  r.u8(); r.u8(); // patch (u16)
  r.u32(); // changelist
  r.fstring(); // branch
  r.i32(); // custom version format
  const cvCount = r.i32();
  for (let i = 0; i < cvCount; i++) {
    r.take(16); // guid
    r.i32(); // version
  }
  r.fstring(); // SaveGameClassName
}

function readPropertyList(r: BinaryReader): Property[] {
  const props: Property[] = [];
  for (;;) {
    const name = r.fstring();
    if (name === "None") break;
    props.push(readProperty(r, name));
  }
  return props;
}

function readProperty(r: BinaryReader, name: string): Property {
  const type = r.fstring();
  const size = r.i32();
  const arrayIndex = r.i32();

  let value: Value;
  let guidFlag = 0;
  let guid: Uint8Array | undefined;
  const readGuid = () => {
    guidFlag = r.u8();
    if (guidFlag) guid = r.take(16);
  };

  switch (type) {
    case "IntProperty":
      readGuid();
      value = { kind: "int", value: r.i32() };
      break;
    case "FloatProperty":
      readGuid();
      value = { kind: "float", value: r.f32() };
      break;
    case "BoolProperty": {
      const b = r.u8(); // value lives in the tag; Size is 0
      readGuid();
      value = { kind: "bool", value: b !== 0 };
      break;
    }
    case "StrProperty":
      readGuid();
      value = { kind: "str", value: r.fstring() };
      break;
    case "NameProperty":
      readGuid();
      value = { kind: "name", value: r.fstring() };
      break;
    case "ObjectProperty":
      readGuid();
      value = { kind: "object", value: r.fstring() };
      break;
    case "ByteProperty": {
      const enumName = r.fstring();
      readGuid();
      value = { kind: "byte", enumName, bytes: r.take(size) };
      break;
    }
    case "StructProperty": {
      const structType = r.fstring();
      const structGuid = r.take(16);
      readGuid();
      const body = readStructBody(r, structType, size);
      value = { kind: "struct", structType, structGuid, body };
      break;
    }
    case "ArrayProperty": {
      const innerType = r.fstring();
      readGuid();
      const av = readArray(r, innerType, size);
      value = { kind: "array", innerType, value: av };
      break;
    }
    case "MapProperty": {
      const keyType = r.fstring();
      const valueType = r.fstring();
      readGuid();
      const mv = readMap(r, keyType, valueType);
      value = { kind: "map", keyType, valueType, value: mv };
      break;
    }
    case "TextProperty":
      readGuid();
      value = { kind: "opaque", bytes: r.take(size) };
      break;
    default:
      throw new Error(`unsupported property type ${type} at ${name}`);
  }

  return { name, type, arrayIndex, guidFlag, guid, value };
}

function readStructBody(r: BinaryReader, structType: string, size: number): StructBody {
  if (structType in NATIVE_STRUCT_SIZE) {
    return { kind: "native", bytes: r.take(size) };
  }
  return { kind: "props", props: readPropertyList(r) };
}

function readArray(r: BinaryReader, innerType: string, size: number): ArrayValue {
  const count = r.i32();
  if (innerType === "StructProperty") {
    const header: StructArrayHeader = {
      propName: r.fstring(),
      propType: r.fstring(),
      arrayIndex: 0,
      structType: "",
      guid: new Uint8Array(),
      guidFlag: 0,
    };
    r.i32(); // inner total size (recomputed on write)
    header.arrayIndex = r.i32();
    header.structType = r.fstring();
    header.guid = r.take(16);
    header.guidFlag = r.u8();
    const items: StructBody[] = [];
    const nativeSize = NATIVE_STRUCT_SIZE[header.structType];
    for (let i = 0; i < count; i++) {
      if (nativeSize !== undefined) items.push({ kind: "native", bytes: r.take(nativeSize) });
      else items.push({ kind: "props", props: readPropertyList(r) });
    }
    return { kind: "struct", header, items };
  }

  // A ByteProperty array is either raw uint8 data or enum values stored as
  // FName per element. Distinguish by whether the element bytes (size minus the
  // count int32) exactly equal the element count.
  if (innerType === "ByteProperty") {
    const byteAsName = size - 4 !== count;
    const items: Scalar[] = [];
    for (let i = 0; i < count; i++) items.push(byteAsName ? r.fstring() : r.u8());
    return { kind: "primitive", innerType, items, byteAsName };
  }

  const items: Scalar[] = [];
  for (let i = 0; i < count; i++) items.push(readPrimitive(r, innerType));
  return { kind: "primitive", innerType, items };
}

function readPrimitive(r: BinaryReader, innerType: string): Scalar {
  switch (innerType) {
    case "IntProperty":
      return r.i32();
    case "FloatProperty":
      return r.f32();
    case "BoolProperty":
      return r.u8() !== 0;
    case "ByteProperty":
      return r.u8();
    case "StrProperty":
    case "NameProperty":
    case "ObjectProperty":
    case "EnumProperty":
      return r.fstring();
    default:
      throw new Error(`unsupported array inner type ${innerType}`);
  }
}

// The value payload of a MapProperty (counted by the tag's Size): an int32
// num-keys-to-remove (normally 0), an int32 element count, then that many
// key/value pairs serialized back-to-back per the inner types.
function readMap(r: BinaryReader, keyType: string, valueType: string): MapValue {
  const numKeysToRemove = r.i32();
  const count = r.i32();
  const entries: MapEntry[] = [];
  for (let i = 0; i < count; i++) {
    const key = readMapEntry(r, keyType);
    const value = readMapEntry(r, valueType);
    entries.push({ key, value });
  }
  return { numKeysToRemove, entries };
}

function readMapEntry(r: BinaryReader, innerType: string): MapEntryData {
  // Non-native structs serialize as a bare property list (terminated by None).
  if (innerType === "StructProperty") {
    return { kind: "struct", body: { kind: "props", props: readPropertyList(r) } };
  }
  // A ByteProperty key/value is an enum FName, not a raw byte, inside a map.
  if (innerType === "ByteProperty") return { kind: "primitive", value: r.fstring() };
  return { kind: "primitive", value: readPrimitive(r, innerType) };
}

// ---------------------------------------------------------------- writing ----

export function writeGvas(file: GvasFile): Uint8Array {
  const w = new BinaryWriter();
  w.raw(file.header);
  writePropertyList(w, file.root);
  w.raw(file.trailer);
  return w.finish();
}

function writePropertyList(w: BinaryWriter, props: Property[]): void {
  for (const p of props) writeProperty(w, p);
  w.fstring("None");
}

function writeProperty(w: BinaryWriter, p: Property): void {
  const tagExtra = new BinaryWriter();
  const valueBuf = new BinaryWriter();
  writeTagExtra(tagExtra, p.value);
  writeValue(valueBuf, p.value);
  const value = valueBuf.finish();

  w.fstring(p.name);
  w.fstring(p.type);
  w.i32(value.length);
  w.i32(p.arrayIndex);
  w.raw(tagExtra.finish());
  w.u8(p.guidFlag);
  if (p.guidFlag && p.guid) w.raw(p.guid);
  w.raw(value);
}

// Type-specific fields that live in the tag (before the hasGuid byte) and are
// NOT counted in the property's Size.
function writeTagExtra(w: BinaryWriter, v: Value): void {
  switch (v.kind) {
    case "bool":
      w.u8(v.value ? 1 : 0);
      break;
    case "byte":
      w.fstring(v.enumName);
      break;
    case "struct":
      w.fstring(v.structType);
      w.raw(v.structGuid);
      break;
    case "array":
      w.fstring(v.innerType);
      break;
    case "map":
      w.fstring(v.keyType);
      w.fstring(v.valueType);
      break;
    default:
      break;
  }
}

function writeValue(w: BinaryWriter, v: Value): void {
  switch (v.kind) {
    case "int":
      w.i32(v.value);
      break;
    case "float":
      w.f32(v.value);
      break;
    case "bool":
      break; // value already emitted into the tag
    case "str":
    case "name":
    case "object":
      w.fstring(v.value);
      break;
    case "byte":
      w.raw(v.bytes);
      break;
    case "opaque":
      w.raw(v.bytes);
      break;
    case "struct":
      writeStructBody(w, v.body);
      break;
    case "array":
      writeArray(w, v.value);
      break;
    case "map":
      writeMap(w, v.keyType, v.valueType, v.value);
      break;
  }
}

function writeStructBody(w: BinaryWriter, body: StructBody): void {
  if (body.kind === "native") w.raw(body.bytes);
  else writePropertyList(w, body.props);
}

function writeArray(w: BinaryWriter, av: ArrayValue): void {
  if (av.kind === "struct") {
    w.i32(av.items.length);
    const elems = new BinaryWriter();
    for (const item of av.items) writeStructBody(elems, item);
    const elemBytes = elems.finish();
    w.fstring(av.header.propName);
    w.fstring(av.header.propType);
    w.i32(elemBytes.length);
    w.i32(av.header.arrayIndex);
    w.fstring(av.header.structType);
    w.raw(av.header.guid);
    w.u8(av.header.guidFlag);
    w.raw(elemBytes);
    return;
  }

  w.i32(av.items.length);
  if (av.innerType === "ByteProperty" && av.byteAsName) {
    for (const item of av.items) w.fstring(item as string);
    return;
  }
  for (const item of av.items) writePrimitive(w, av.innerType, item);
}

function writeMap(w: BinaryWriter, keyType: string, valueType: string, mv: MapValue): void {
  w.i32(mv.numKeysToRemove);
  w.i32(mv.entries.length);
  for (const e of mv.entries) {
    writeMapEntry(w, keyType, e.key);
    writeMapEntry(w, valueType, e.value);
  }
}

function writeMapEntry(w: BinaryWriter, innerType: string, data: MapEntryData): void {
  if (data.kind === "struct") {
    writeStructBody(w, data.body);
    return;
  }
  // Mirror readMapEntry: a ByteProperty entry is an enum FName.
  if (innerType === "ByteProperty") {
    w.fstring(data.value as string);
    return;
  }
  writePrimitive(w, innerType, data.value);
}

function writePrimitive(w: BinaryWriter, innerType: string, item: Scalar): void {
  switch (innerType) {
    case "IntProperty":
      w.i32(item as number);
      break;
    case "FloatProperty":
      w.f32(item as number);
      break;
    case "BoolProperty":
      w.u8(item ? 1 : 0);
      break;
    case "ByteProperty":
      w.u8(item as number);
      break;
    case "StrProperty":
    case "NameProperty":
    case "ObjectProperty":
    case "EnumProperty":
      w.fstring(item as string);
      break;
    default:
      throw new Error(`unsupported array inner type ${innerType}`);
  }
}
