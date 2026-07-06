// Diffs the live tree against a snapshot taken at load, powering the pre-save
// review: exactly what will be written, nothing hidden.

import type { ScalarLeaf } from "./gvas/edit";
import type { ContainerView } from "./gvas/items";

type Scalar = number | boolean | string;

// Per-slot internals (transforms, saved variables) live at index paths that
// shift on every add/remove, which would flood the field diff with noise;
// container edits are reported structurally by key instead.
const CONTAINER_PATH = /^(inventoryData|equipment|hold|GObjStack)\[/;

export interface Snapshot {
  scalars: Map<string, Scalar>;
  items: Map<string, { classPath: string; label: string }>; // "inventory:<key>"
}

export interface FieldChange {
  leaf: ScalarLeaf;
  before: Scalar;
  after: Scalar;
}

export interface ItemChange {
  container: "inventory" | "equipment";
  action: "added" | "removed" | "changed";
  label: string;
  classPath: string;
}

export interface ChangeSet {
  fields: FieldChange[];
  items: ItemChange[];
}

const containers = (inv: ContainerView | null, eq: ContainerView | null) =>
  [
    ["inventory", inv],
    ["equipment", eq],
  ] as const;

// Inventory items carry a unique key; equipment slots don't expose one, so
// they fall back to positional identity (stable — equipment is a fixed rack).
const slotId = (name: string, it: { key: string; index: number }): string =>
  `${name}:${it.key || `@${it.index}`}`;

export function takeSnapshot(
  leaves: ScalarLeaf[],
  inv: ContainerView | null,
  eq: ContainerView | null,
): Snapshot {
  const scalars = new Map<string, Scalar>();
  for (const l of leaves) if (!CONTAINER_PATH.test(l.path)) scalars.set(l.path, l.get());
  const items = new Map<string, { classPath: string; label: string }>();
  for (const [name, view] of containers(inv, eq)) {
    if (view) for (const it of view.items) items.set(slotId(name, it), { classPath: it.classPath, label: it.label });
  }
  return { scalars, items };
}

// Floats compare at f32 precision: the file stores 32 bits, so a re-typed value
// that lands on the same f32 writes identical bytes and is not a change.
const differs = (kind: ScalarLeaf["kind"], a: Scalar, b: Scalar): boolean =>
  kind === "float" ? Math.fround(a as number) !== Math.fround(b as number) : a !== b;

export function diffAgainst(
  snap: Snapshot,
  leaves: ScalarLeaf[],
  inv: ContainerView | null,
  eq: ContainerView | null,
): ChangeSet {
  const fields: FieldChange[] = [];
  for (const leaf of leaves) {
    if (CONTAINER_PATH.test(leaf.path)) continue;
    const before = snap.scalars.get(leaf.path);
    if (before === undefined) continue; // new structural paths report as item changes
    const after = leaf.get();
    if (differs(leaf.kind, before, after)) fields.push({ leaf, before, after });
  }

  const items: ItemChange[] = [];
  const seen = new Set<string>();
  for (const [name, view] of containers(inv, eq)) {
    if (!view) continue;
    for (const it of view.items) {
      const id = slotId(name, it);
      seen.add(id);
      const before = snap.items.get(id);
      if (!before) items.push({ container: name, action: "added", label: it.label, classPath: it.classPath });
      else if (before.classPath !== it.classPath)
        items.push({
          container: name,
          action: "changed",
          label: `${before.label} → ${it.label}`,
          classPath: it.classPath,
        });
    }
  }
  for (const [id, before] of snap.items) {
    if (seen.has(id)) continue;
    const container = id.startsWith("inventory:") ? "inventory" : "equipment";
    items.push({ container, action: "removed", label: before.label, classPath: before.classPath });
  }
  return { fields, items };
}
