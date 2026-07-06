import { describe, expect, test } from "bun:test";
import { decodeStructBody, encodeStructBody } from "./gvas";
import type { GvasFile, Property, StructBody } from "./gvas";
import { getContainer, loadItemTemplates } from "./items";
import { ITEM_TEMPLATE_INDEX, ITEM_TEMPLATES_GZ } from "./item-templates";

const stripGuid = (name: string): string => name.replace(/_\d+_[0-9A-Fa-f]{32}$/, "");
const find = (props: Property[], base: string): Property | undefined =>
  props.find((p) => stripGuid(p.name) === base);

function classOf(el: StructBody): string {
  if (el.kind !== "props") return "";
  const c = find(el.props, "class")?.value;
  return c?.kind === "object" ? c.value : "";
}

function idOf(el: StructBody): string {
  if (el.kind !== "props") return "";
  const names = find(el.props, "names")?.value;
  if (names?.kind !== "array" || names.value.kind !== "struct") return "";
  const first = names.value.items[0];
  if (!first || first.kind !== "props") return "";
  const batch = first.props[0]?.value;
  if (batch?.kind !== "array" || batch.value.kind !== "primitive") return "";
  return typeof batch.value.items[0] === "string" ? (batch.value.items[0] as string) : "";
}

async function templateBlob(): Promise<Uint8Array> {
  const gz = Uint8Array.from(atob(ITEM_TEMPLATES_GZ), (c) => c.charCodeAt(0));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("encodeStructBody/decodeStructBody", () => {
  test("round-trips a props body", () => {
    const body: StructBody = {
      kind: "props",
      props: [
        { name: "class", type: "ObjectProperty", arrayIndex: 0, guidFlag: 0, value: { kind: "object", value: "/Game/x.x_C" } },
        { name: "key", type: "NameProperty", arrayIndex: 0, guidFlag: 0, value: { kind: "name", value: "abc" } },
        { name: "n", type: "IntProperty", arrayIndex: 0, guidFlag: 0, value: { kind: "int", value: -7 } },
      ],
    };
    const bytes = encodeStructBody(body);
    const back = decodeStructBody(bytes);
    expect(back).toEqual(body);
    expect(encodeStructBody(back)).toEqual(bytes);
  });

  test("round-trips an empty props body", () => {
    const body: StructBody = { kind: "props", props: [] };
    expect(decodeStructBody(encodeStructBody(body))).toEqual(body);
  });
});

describe("bundled template database", () => {
  test("every entry decodes to an element of its own class with a real id", async () => {
    const blob = await templateBlob();
    const entries = Object.entries(ITEM_TEMPLATE_INDEX);
    expect(entries.length).toBeGreaterThan(200);
    for (const [classPath, [offset, length]] of entries) {
      const el = decodeStructBody(blob.subarray(offset, offset + length));
      expect(classOf(el)).toBe(classPath);
      const id = idOf(el);
      expect(id).not.toBe("");
      expect(id).not.toMatch(/^[A-Za-z0-9_-]{22}$/); // ids are registry names, never keys
    }
  });

  test("spans tile the blob exactly", async () => {
    const blob = await templateBlob();
    const spans = Object.values(ITEM_TEMPLATE_INDEX).slice().sort((a, b) => a[0] - b[0]);
    let expected = 0;
    for (const [offset, length] of spans) {
      expect(offset).toBe(expected);
      expected += length;
    }
    expect(expected).toBe(blob.length);
  });
});

// Minimal save: empty inventory, one empty player stack, no world objects — the
// donor-less worst case where only a bundled template can supply item state.
function syntheticFile(): GvasFile {
  const structArray = (propName: string, items: StructBody[]): Property => ({
    name: propName,
    type: "ArrayProperty",
    arrayIndex: 0,
    guidFlag: 0,
    value: {
      kind: "array",
      innerType: "StructProperty",
      value: {
        kind: "struct",
        header: { propName, propType: "StructProperty", arrayIndex: 0, structType: "struct_save", guid: new Uint8Array(16), guidFlag: 0 },
        items,
      },
    },
  });
  const stackEntry: StructBody = { kind: "props", props: [structArray("obj", [])] };
  return {
    header: new Uint8Array(0),
    root: [structArray("inventoryData", []), structArray("GObjStack", [stackEntry])],
    trailer: new Uint8Array(0),
  };
}

describe("donor-less add via bundled template", () => {
  test("adds an exact item and mirrors it into the player stack", async () => {
    await loadItemTemplates();
    const classPath = Object.keys(ITEM_TEMPLATE_INDEX)[0]!;
    const file = syntheticFile();
    const view = getContainer(file, "inventoryData");
    expect(view).not.toBeNull();
    expect(view!.canAdd).toBe(true);

    expect(view!.add(classPath)).toBe(true); // exact: bundled state, not a foreign clone
    expect(view!.items).toHaveLength(1);
    expect(view!.items[0]!.classPath).toBe(classPath);
    expect(view!.items[0]!.warn).toBeUndefined();

    const inv = find(file.root, "inventoryData")?.value;
    if (inv?.kind !== "array" || inv.value.kind !== "struct") throw new Error("inventory shape");
    const added = inv.value.items[0]!;
    expect(idOf(added)).not.toBe("");
    expect(view!.items[0]!.key).not.toBe(""); // rekeyed, not the template's key

    const stack = find(file.root, "GObjStack")?.value;
    if (stack?.kind !== "array" || stack.value.kind !== "struct") throw new Error("stack shape");
    const entry = stack.value.items[0]!;
    if (entry.kind !== "props") throw new Error("entry shape");
    const obj = find(entry.props, "obj")?.value;
    if (obj?.kind !== "array" || obj.value.kind !== "struct") throw new Error("obj shape");
    expect(obj.value.items).toHaveLength(1); // mirror synced
    expect(encodeStructBody(obj.value.items[0]!)).toEqual(encodeStructBody(added));
  });

  test("unknown class still adds nothing exact and reports false", async () => {
    await loadItemTemplates();
    const file = syntheticFile();
    const view = getContainer(file, "inventoryData");
    expect(view!.add("/Game/objects/portal_phys.portal_phys_C")).toBe(false);
  });
});
