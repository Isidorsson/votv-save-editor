import { readGvas, writeGvas, type GvasFile } from "./gvas/gvas";
import { collectLeaves, coerceInput, BAR_GROUP_IDS, FIELD_GROUPS, type ScalarLeaf } from "./gvas/edit";
import {
  getContainer,
  buildCatalog,
  donorClasses,
  friendlyName,
  loadItemTemplates,
  type CatalogEntry,
  type ContainerView,
} from "./gvas/items";
import { canPickFiles, handleFromDrop, pickSave, writeInPlace } from "./fs";
import { diffAgainst, takeSnapshot, type Snapshot } from "./diff";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  file: $<HTMLInputElement>("file"),
  open: $<HTMLButtonElement>("open"),
  emptyOpen: $<HTMLButtonElement>("emptyOpen"),
  save: $<HTMLButtonElement>("save"),
  backup: $<HTMLButtonElement>("backup"),
  empty: $<HTMLElement>("empty"),
  loading: $<HTMLElement>("loading"),
  editor: $<HTMLElement>("editor"),
  fileChip: $<HTMLElement>("fileChip"),
  fileName: $<HTMLElement>("fileName"),
  fileMeta: $<HTMLElement>("fileMeta"),
  readout: $<HTMLElement>("readout"),
  groups: $<HTMLElement>("groups"),
  inv: $<HTMLElement>("inv"),
  eq: $<HTMLElement>("eq"),
  invSection: $<HTMLElement>("sec-inventory"),
  eqSection: $<HTMLElement>("sec-equipment"),
  invCount: $<HTMLElement>("invCount"),
  eqCount: $<HTMLElement>("eqCount"),
  invAdd: $<HTMLButtonElement>("invAdd"),
  eqAdd: $<HTMLButtonElement>("eqAdd"),
  search: $<HTMLInputElement>("search"),
  all: $<HTMLElement>("all"),
  rail: $<HTMLElement>("rail"),
  modal: $<HTMLDialogElement>("modal"),
  modalTitle: $<HTMLElement>("modalTitle"),
  modalClose: $<HTMLButtonElement>("modalClose"),
  pickSearch: $<HTMLInputElement>("pickSearch"),
  pickList: $<HTMLElement>("pickList"),
  pickCount: $<HTMLElement>("pickCount"),
  pickEmpty: $<HTMLElement>("pickEmpty"),
  pickEmptyTerm: $<HTMLElement>("pickEmptyTerm"),
  customPath: $<HTMLInputElement>("customPath"),
  customUse: $<HTMLButtonElement>("customUse"),
  toasts: $<HTMLElement>("toasts"),
  dropveil: $<HTMLElement>("dropveil"),
  review: $<HTMLDialogElement>("review"),
  reviewClose: $<HTMLButtonElement>("reviewClose"),
  reviewBody: $<HTMLElement>("reviewBody"),
  reviewDest: $<HTMLElement>("reviewDest"),
  reviewCancel: $<HTMLButtonElement>("reviewCancel"),
  reviewWrite: $<HTMLButtonElement>("reviewWrite"),
};

interface State {
  file: GvasFile | null;
  leaves: ScalarLeaf[];
  byPath: Map<string, ScalarLeaf>;
  catalog: CatalogEntry[];
  donors: Set<string>;
  inv: ContainerView | null;
  eq: ContainerView | null;
  original: Uint8Array | null;
  name: string;
  dirty: boolean;
  handle: FileSystemFileHandle | null; // present => Save writes back in place
  snapshot: Snapshot | null; // state at load, diffed for the pre-save review
  backedUp: boolean; // original already downloaded before an in-place write
}
const state: State = {
  file: null,
  leaves: [],
  byPath: new Map(),
  catalog: [],
  donors: new Set(),
  inv: null,
  eq: null,
  original: null,
  name: "",
  dirty: false,
  handle: null,
  snapshot: null,
  backedUp: false,
};

const UPGRADE_NOMINAL_MAX = 16; // visual reference for the level bar only

// --------------------------------------------------------------------- toasts

function toast(msg: string, kind: "ok" | "err" = "ok"): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = kind === "ok" ? "✓" : "!";
  const text = document.createElement("span");
  text.textContent = msg;
  el.append(ic, text);
  els.toasts.append(el);
  const remove = () => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  setTimeout(remove, kind === "err" ? 7000 : 4000);
  el.addEventListener("click", remove);
}

// --------------------------------------------------------------------- states

function showState(which: "empty" | "loading" | "editor"): void {
  els.empty.hidden = which !== "empty";
  els.loading.hidden = which !== "loading";
  els.editor.hidden = which !== "editor";
}

async function loadFile(f: File, handle: FileSystemFileHandle | null = null): Promise<void> {
  if (state.dirty && !confirm(`Discard unsaved edits to ${state.name}?`)) return;
  showState("loading");
  // Yield two frames so the loading state paints before the synchronous parse
  // of a multi-megabyte save blocks the main thread. rAF stops firing entirely
  // in background tabs, so a timeout backstop keeps the load from stalling.
  await new Promise((r) => {
    requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)));
    setTimeout(r, 250);
  });
  try {
    await loadItemTemplates(); // bundled donor states must be ready before views build
    const bytes = new Uint8Array(await f.arrayBuffer());
    const parsed = readGvas(bytes);
    state.file = parsed;
    state.original = bytes;
    state.name = f.name;
    state.dirty = false;
    state.handle = handle;
    state.backedUp = false;
    state.catalog = buildCatalog(parsed);
    rebuild();
    state.snapshot = takeSnapshot(state.leaves, state.inv, state.eq);
    els.save.disabled = false;
    els.save.title = handle
      ? "Review changes, then write directly back to the file (Ctrl+S)"
      : "Review changes, then download the edited save (Ctrl+S)";
    els.backup.disabled = false;
    els.fileChip.hidden = false;
    showState("editor");
    renderAll();
    toast(
      `Loaded ${f.name} — ${state.leaves.length} fields, ${state.catalog.length} item types` +
        (handle ? ". Saves write back to the file." : ""),
    );
  } catch (e) {
    showState(state.file ? "editor" : "empty");
    toast(`Couldn't parse that save: ${(e as Error).message}`, "err");
  }
}

function rebuild(): void {
  if (!state.file) return;
  state.leaves = collectLeaves(state.file);
  state.byPath = new Map(state.leaves.map((l) => [l.path, l]));
  state.donors = donorClasses(state.file);
  state.inv = getContainer(state.file, "inventoryData");
  state.eq = getContainer(state.file, "equipment");
}

function markDirty(): void {
  if (state.dirty) return;
  state.dirty = true;
  els.fileChip.classList.add("dirty");
  renderChip();
}

// ------------------------------------------------------------------- rendering

function renderAll(): void {
  renderChip();
  renderReadout();
  renderGroups();
  renderContainerSection(state.inv, els.invSection, els.inv, els.invCount, els.invAdd, "inventory");
  renderContainerSection(state.eq, els.eqSection, els.eq, els.eqCount, els.eqAdd, "equipment");
  renderRaw();
  buildRail();
  observeSections();
}

function renderChip(): void {
  els.fileName.textContent = state.name;
  els.fileMeta.textContent = state.dirty
    ? "· unsaved"
    : `· ${((state.original?.length ?? 0) / 1_048_576).toFixed(1)} MB`;
}

function stat(k: string, v: string, cls = ""): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "stat";
  const kk = document.createElement("span");
  kk.className = "k";
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.className = `v ${cls}`.trim();
  vv.textContent = v;
  wrap.append(kk, vv);
  return wrap;
}

// Readout adapts to the file: game saves show Points/Day, data.sav shows
// lifetime stats. Only present values render.
function renderReadout(): void {
  const num = (path: string): number | null => {
    const v = state.byPath.get(path)?.get();
    return typeof v === "number" ? v : null;
  };
  const stats: HTMLElement[] = [];
  const points = num("Points") ?? num("Stats.total_points");
  if (points !== null) stats.push(stat("Points", points.toLocaleString(), "accent"));
  const day = num("Day");
  if (day !== null) stats.push(stat("Day", day.toFixed(1)));
  const signals = num("Stats.signals_found");
  if (signals !== null) stats.push(stat("Signals", signals.toLocaleString()));
  const days = num("Stats.days_total");
  if (days !== null) stats.push(stat("Days", String(days)));
  const total = num("totalTime") ?? num("Stats.total_playtime");
  if (total !== null) stats.push(stat("Playtime", `${(total / 3600).toFixed(1)} h`));
  if (state.inv) stats.push(stat("Inventory", String(state.inv.items.length)));
  stats.push(stat("Save size", `${((state.original?.length ?? 0) / 1_048_576).toFixed(1)} MB`));
  stats.push(stat("Status", state.dirty ? "unsaved edits" : "clean", state.dirty ? "warn" : ""));
  els.readout.replaceChildren(...stats);
}

// Floats in the save are 32-bit, so the parsed double often reads as noise like
// 0.10000000149011612. Show the shortest decimal that maps to the same f32.
function shortFloat(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const target = Math.fround(v);
  for (let p = 1; p <= 9; p++) {
    const short = Number(v.toPrecision(p));
    if (Math.fround(short) === target) return String(short);
  }
  return String(v);
}

function fmtScalar(kind: ScalarLeaf["kind"], v: number | boolean | string): string {
  return kind === "float" && typeof v === "number" ? shortFloat(v) : String(v);
}

function displayValue(leaf: ScalarLeaf): string {
  return fmtScalar(leaf.kind, leaf.get());
}

// number/text input or a toggle, wired through coerceInput. `after` runs on a
// committed valid edit (e.g. to update a level bar).
function makeInput(leaf: ScalarLeaf, after?: () => void): HTMLElement {
  if (leaf.kind === "bool") {
    const label = document.createElement("label");
    label.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = leaf.get() as boolean;
    const track = document.createElement("span");
    track.className = "track";
    input.onchange = () => {
      leaf.set(input.checked);
      commit(after);
    };
    label.append(input, track);
    return label;
  }

  const input = document.createElement("input");
  input.type = leaf.kind === "str" ? "text" : "number";
  input.value = displayValue(leaf);
  input.onchange = () => {
    const res = coerceInput(input.value, leaf.kind);
    if (!res.ok) {
      input.classList.add("bad");
      toast(`${leaf.path}: ${res.error}`, "err");
      return;
    }
    input.classList.remove("bad");
    leaf.set(res.value);
    input.value = displayValue(leaf);
    commit(after);
  };
  return input;
}

function commit(after?: () => void): void {
  markDirty();
  renderReadout();
  after?.();
}

// Sections actually rendered for the current file (drives the rail).
const shownGroups: { id: string; title: string }[] = [];

function fieldRow(label: string, hint: string | undefined, leaf: ScalarLeaf): HTMLElement {
  const row = document.createElement("div");
  row.className = "field";
  const lab = document.createElement("div");
  lab.className = "lab";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  lab.append(name);
  if (hint) {
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = hint;
    lab.append(h);
  }
  row.append(lab, makeInput(leaf));
  return row;
}

function upgCell(label: string, leaf: ScalarLeaf): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "upg";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  const row = document.createElement("div");
  row.className = "row";
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("span");
  bar.append(fill);
  const setBar = () => {
    fill.style.width = `${Math.max(0, Math.min(1, Number(leaf.get()) / UPGRADE_NOMINAL_MAX)) * 100}%`;
  };
  setBar();
  row.append(makeInput(leaf, setBar), bar);
  cell.append(name, row);
  return cell;
}

function maxUpgrades(groupId: string): void {
  const group = FIELD_GROUPS.find((g) => g.id === groupId);
  for (const f of group?.fields ?? []) {
    const leaf = state.byPath.get(f.path);
    if (leaf?.kind === "int") leaf.set(UPGRADE_NOMINAL_MAX);
  }
  markDirty();
  renderGroups();
  renderReadout();
  toast("All upgrades set to 16");
}

// Build a section per curated group that has at least one present field.
function renderGroups(): void {
  els.groups.replaceChildren();
  shownGroups.length = 0;
  for (const group of FIELD_GROUPS) {
    const present = group.fields
      .map((f) => ({ f, leaf: state.byPath.get(f.path) }))
      .filter((x): x is { f: (typeof group.fields)[number]; leaf: ScalarLeaf } => !!x.leaf);
    if (!present.length) continue;

    const section = document.createElement("section");
    section.id = `sec-${group.id}`;
    section.className = "section";

    const head = document.createElement("div");
    head.className = "section-head";
    const h2 = document.createElement("h2");
    h2.textContent = group.title;
    head.append(h2);
    if (group.id === "upgrades") {
      const maxBtn = document.createElement("button");
      maxBtn.className = "btn ghost sm";
      maxBtn.textContent = "Max all";
      maxBtn.onclick = () => maxUpgrades(group.id);
      head.append(maxBtn);
    }
    section.append(head);

    if (BAR_GROUP_IDS.has(group.id)) {
      const grid = document.createElement("div");
      grid.className = "upg-grid";
      for (const { f, leaf } of present) if (leaf.kind === "int") grid.append(upgCell(f.label, leaf));
      section.append(grid);
    } else {
      const grid = document.createElement("div");
      grid.className = "field-grid";
      for (const { f, leaf } of present) grid.append(fieldRow(f.label, f.hint, leaf));
      section.append(grid);
    }

    els.groups.append(section);
    shownGroups.push({ id: section.id, title: group.title });
  }
}

function renderContainerSection(
  view: ContainerView | null,
  section: HTMLElement,
  host: HTMLElement,
  countEl: HTMLElement,
  addBtn: HTMLButtonElement,
  kind: "inventory" | "equipment",
): void {
  section.hidden = !view; // hide the whole section (and its rail link) when absent
  if (!view) return;
  host.replaceChildren();
  countEl.textContent = `(${view.items.length})`;
  addBtn.disabled = !view.canAdd;

  for (const item of view.items) {
    const row = document.createElement("div");
    row.className = item.classPath ? "item" : "item empty";
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.classPath ? item.label : "(empty slot)";
    if (item.warn) {
      const w = document.createElement("span");
      w.className = "wflag";
      w.textContent = "⚠ wrong id";
      w.title = item.warn;
      name.append(w);
    }
    const cls = document.createElement("div");
    cls.className = "cls";
    cls.textContent = item.classPath || "—";
    info.append(name, cls);
    row.append(info);

    const change = document.createElement("button");
    change.className = "btn ghost sm";
    change.textContent = "Change";
    change.onclick = () =>
      openPicker(`Set ${kind} item`, (path) => {
        item.setClass(path);
        afterStructuralEdit();
      });
    row.append(change);

    // Equipment rows are named slots, so duplicating one makes no sense there.
    if (kind === "inventory" && item.classPath) {
      const dup = document.createElement("button");
      dup.className = "btn ghost sm";
      dup.textContent = "⧉";
      dup.title = "Duplicate item (exact copy, new key)";
      dup.setAttribute("aria-label", `Duplicate ${item.label}`);
      dup.onclick = () => {
        view.duplicate(item.index);
        afterStructuralEdit();
      };
      row.append(dup);
    }

    const del = document.createElement("button");
    del.className = "btn danger";
    del.textContent = "✕";
    del.title = "Remove item";
    del.setAttribute("aria-label", `Remove ${item.label}`);
    del.onclick = () => {
      view.remove(item.index);
      afterStructuralEdit();
    };
    row.append(del);

    host.append(row);
  }
}

function renderRaw(): void {
  els.all.replaceChildren();
  for (const leaf of state.leaves) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.path = leaf.path.toLowerCase();
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = leaf.path;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = leaf.kind;
    row.append(path, kind, makeInput(leaf));
    els.all.append(row);
  }
}

function filterRows(q: string): void {
  const needle = q.toLowerCase();
  for (const row of Array.from(els.all.children) as HTMLElement[]) {
    row.classList.toggle("hidden", !!needle && !row.dataset.path!.includes(needle));
  }
}

function afterStructuralEdit(): void {
  rebuild();
  renderAll();
  markDirty();
}

// --------------------------------------------------------------------- picker

// The catalog runs to 1,200+ entries, so the picker renders only the current
// matches (capped) instead of the whole list, and keeps focus in the search box
// while arrow keys move a roving highlight (aria-activedescendant combobox).
const PICK_CAP = 200;

let pickTarget: ((path: string) => void) | null = null;
let pickRows: HTMLButtonElement[] = [];
let pickActive = -1;

function renderPickList(query: string): void {
  const q = query.trim().toLowerCase();
  const matches = q
    ? state.catalog.filter((e) => `${e.name} ${e.classPath}`.toLowerCase().includes(q))
    : state.catalog;
  const shown = matches.slice(0, PICK_CAP);

  const frag = document.createDocumentFragment();
  pickRows = shown.map((entry, i) => {
    const row = document.createElement("button");
    row.className = "pick";
    row.type = "button";
    row.id = `pick-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    const n = document.createElement("span");
    n.className = "pname";
    n.textContent = entry.name;
    const c = document.createElement("span");
    c.className = "pcls";
    c.textContent = entry.classPath.split("/").pop() ?? "";
    row.append(n, c);
    if (!state.donors.has(entry.classPath)) {
      const f = document.createElement("span");
      f.className = "pflag";
      f.textContent = "no template";
      f.title =
        "No item of this class exists in this save or the bundled template library to copy state from — if added, it may appear as a different item in game.";
      row.append(f);
    }
    row.onclick = () => choose(entry.classPath);
    row.onmousemove = () => {
      if (pickActive !== i) setActive(i);
    };
    frag.append(row);
    return row;
  });
  els.pickList.replaceChildren(frag);

  const empty = shown.length === 0;
  els.pickList.hidden = empty;
  els.pickEmpty.hidden = !empty;
  els.pickEmptyTerm.textContent = query.trim();
  els.pickCount.textContent = empty
    ? "no matches"
    : matches.length > shown.length
      ? `showing ${shown.length} of ${matches.length.toLocaleString()}`
      : `${matches.length.toLocaleString()} ${matches.length === 1 ? "item" : "items"}`;

  setActive(empty ? -1 : 0);
}

function setActive(i: number): void {
  pickActive = i;
  pickRows.forEach((row, idx) => {
    const on = idx === i;
    row.classList.toggle("active", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
  });
  const row = i >= 0 ? pickRows[i] : undefined;
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    els.pickSearch.setAttribute("aria-activedescendant", row.id);
  } else {
    els.pickSearch.removeAttribute("aria-activedescendant");
  }
}

function moveActive(delta: number): void {
  const n = pickRows.length;
  if (!n) return;
  const next = pickActive < 0 ? (delta > 0 ? 0 : n - 1) : (pickActive + delta + n) % n;
  setActive(next);
}

function onPickKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveActive(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveActive(-1);
      break;
    case "Home":
      if (pickRows.length) {
        e.preventDefault();
        setActive(0);
      }
      break;
    case "End":
      if (pickRows.length) {
        e.preventDefault();
        setActive(pickRows.length - 1);
      }
      break;
    case "Enter": {
      e.preventDefault();
      const row = pickActive >= 0 ? pickRows[pickActive] : undefined;
      if (row) row.click();
      else els.customPath.focus(); // no matches — guide to the escape hatch
      break;
    }
  }
}

// Accept a full "/Game/objects/prop_x.prop_x_C" path as-is, or expand a bare
// summon name ("prop_physgun" / "prop_physgun_c") to the standard object path.
function normalizeClassPath(input: string): string {
  const s = input.trim();
  if (s.startsWith("/") || s.includes(".")) return s;
  const base = s.replace(/_c$/i, "");
  return `/Game/objects/${base}.${base}_C`;
}

function useCustomPath(): void {
  const raw = els.customPath.value.trim();
  if (!raw) {
    els.customPath.focus();
    return;
  }
  choose(normalizeClassPath(raw));
}

function openPicker(title: string, onPick: (path: string) => void): void {
  pickTarget = onPick;
  els.modalTitle.textContent = title;
  els.pickSearch.value = "";
  els.customPath.value = "";
  renderPickList("");
  els.modal.showModal();
  els.pickSearch.focus();
}

function choose(path: string): void {
  const cb = pickTarget;
  pickTarget = null;
  pickRows = [];
  pickActive = -1;
  els.modal.close();
  cb?.(path);
}

// -------------------------------------------------------------------- rail

// Rail reflects exactly the sections rendered for this file.
function buildRail(): void {
  const secs: { id: string; label: string; count?: number }[] = [{ id: "sec-status", label: "Status" }];
  for (const g of shownGroups) secs.push({ id: g.id, label: g.title });
  if (state.inv) secs.push({ id: "sec-inventory", label: "Inventory", count: state.inv.items.length });
  if (state.eq) secs.push({ id: "sec-equipment", label: "Equipment", count: state.eq.items.length });
  secs.push({ id: "sec-raw", label: "All fields" });

  els.rail.replaceChildren();
  for (const s of secs) {
    const a = document.createElement("a");
    a.href = `#${s.id}`;
    a.dataset.sec = s.id;
    a.textContent = s.label;
    if (s.count !== undefined) {
      const em = document.createElement("em");
      em.textContent = String(s.count);
      a.append(" ", em);
    }
    els.rail.append(a);
  }
}

// ----------------------------------------------------------------- scrollspy

let sectionObserver: IntersectionObserver | null = null;
function observeSections(): void {
  sectionObserver?.disconnect();
  const links = new Map(
    (Array.from(els.rail.querySelectorAll("a")) as HTMLAnchorElement[]).map((a) => [a.dataset.sec!, a]),
  );
  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("active"));
        links.get(e.target.id)?.classList.add("active");
      }
    },
    { rootMargin: "-35% 0px -60% 0px", threshold: 0 },
  );
  for (const sec of Array.from(els.editor.querySelectorAll(".section"))) sectionObserver.observe(sec);
}

// ------------------------------------------------------------------ save/io

function download(bytes: Uint8Array, name: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------- review

// Save opens a review of everything that will differ from the loaded file —
// field edits (revertible) and item add/remove/change — before any byte is
// written. The write itself happens in doWrite() after confirmation.

function revRow(c: { leaf: ScalarLeaf; before: number | boolean | string; after: number | boolean | string }): HTMLElement {
  const row = document.createElement("div");
  row.className = "rev-field";
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = c.leaf.path;
  const vals = document.createElement("span");
  vals.className = "vals";
  const before = document.createElement("s");
  before.textContent = fmtScalar(c.leaf.kind, c.before);
  const after = document.createElement("b");
  after.textContent = fmtScalar(c.leaf.kind, c.after);
  vals.append(before, " → ", after);
  const undo = document.createElement("button");
  undo.className = "btn ghost sm";
  undo.textContent = "↺";
  undo.title = `Revert to ${fmtScalar(c.leaf.kind, c.before)}`;
  undo.setAttribute("aria-label", `Revert ${c.leaf.path}`);
  undo.onclick = () => {
    c.leaf.set(c.before);
    renderGroups();
    renderRaw();
    renderReadout();
    renderReview();
  };
  row.append(path, vals, undo);
  return row;
}

function renderReview(): void {
  if (!state.snapshot) return;
  const cs = diffAgainst(state.snapshot, state.leaves, state.inv, state.eq);
  const frag = document.createDocumentFragment();

  if (!cs.fields.length && !cs.items.length) {
    const p = document.createElement("p");
    p.className = "review-none";
    p.textContent = "No changes — the file will be rewritten as loaded.";
    frag.append(p);
  }
  for (const c of cs.items) {
    const row = document.createElement("div");
    row.className = `rev-item ${c.action}`;
    const sign = document.createElement("span");
    sign.className = "sign";
    sign.textContent = c.action === "added" ? "+" : c.action === "removed" ? "−" : "~";
    const label = document.createElement("span");
    label.className = "lab";
    label.textContent = c.label;
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = c.container;
    row.append(sign, label, where);
    frag.append(row);
  }
  for (const c of cs.fields) frag.append(revRow(c));

  els.reviewBody.replaceChildren(frag);
  els.reviewDest.textContent = state.handle ? `writes into ${state.name}` : `downloads ${state.name}`;
  els.reviewWrite.textContent = state.handle ? "Write to file" : "Download save";
}

function save(): void {
  if (!state.file) return;
  renderReview();
  els.review.showModal();
  els.reviewWrite.focus();
}

async function doWrite(): Promise<void> {
  if (!state.file) return;
  let out: Uint8Array;
  try {
    out = writeGvas(state.file);
    readGvas(out); // integrity gate: output must re-parse cleanly
  } catch (e) {
    toast(`Save blocked — output failed verification: ${(e as Error).message}`, "err");
    return;
  }

  if (state.handle) {
    // First in-place write drops a copy of the original in Downloads first, so
    // overwriting the real save is always reversible.
    if (!state.backedUp && state.original) {
      download(state.original, state.name.replace(/\.sav$/i, ".backup.sav"));
      state.backedUp = true;
      toast("Backup of the original downloaded");
    }
    try {
      await writeInPlace(state.handle, out);
      toast(`Written back to ${state.name}`);
    } catch (e) {
      download(out, state.name);
      toast(`Couldn't write in place (${(e as Error).message}) — downloaded instead`, "err");
    }
  } else {
    download(out, state.name);
    toast(`Saved ${state.name}. Keep a backup of your original.`);
  }

  state.dirty = false;
  state.snapshot = takeSnapshot(state.leaves, state.inv, state.eq);
  els.fileChip.classList.remove("dirty");
  renderChip();
  renderReadout();
}

// --------------------------------------------------------------------- wiring

// Chromium gets the native picker (yields a writable handle for in-place
// saves); everything else falls back to the plain file input.
const pickOpen = () => {
  if (!canPickFiles()) {
    els.file.click();
    return;
  }
  pickSave()
    .then((picked) => {
      if (picked) void loadFile(picked.file, picked.handle);
    })
    .catch((e) => toast(`Couldn't open file: ${(e as Error).message}`, "err"));
};
els.open.onclick = pickOpen;
els.emptyOpen.onclick = pickOpen;
els.file.onchange = () => {
  const f = els.file.files?.[0];
  if (f) void loadFile(f);
  els.file.value = "";
};
els.save.onclick = save;
els.backup.onclick = () => {
  if (state.original) {
    download(state.original, state.name.replace(/\.sav$/i, ".backup.sav"));
    toast("Backup of original downloaded");
  }
};
els.search.oninput = () => filterRows(els.search.value);

// An add without a same-class donor or bundled template clones another item's
// state, so the game would show that donor's identity — warn instead of
// failing silently.
function addWithDonorCheck(view: ContainerView | null, path: string): void {
  const exact = view?.add(path) ?? false;
  afterStructuralEdit();
  if (!exact) {
    toast(
      `No ${friendlyName(path)} exists in this save or the bundled templates to copy state from — in game it may appear as a different item. Obtain one in game first, or duplicate an existing row.`,
      "err",
    );
  }
}

els.invAdd.onclick = () => openPicker("Add inventory item", (path) => addWithDonorCheck(state.inv, path));
els.eqAdd.onclick = () => openPicker("Add equipment item", (path) => addWithDonorCheck(state.eq, path));

els.pickSearch.oninput = () => renderPickList(els.pickSearch.value);
els.pickSearch.onkeydown = onPickKeydown;
els.modalClose.onclick = () => els.modal.close();
els.modal.onclick = (e) => {
  if (e.target === els.modal) els.modal.close(); // backdrop click
};
els.reviewClose.onclick = () => els.review.close();
els.reviewCancel.onclick = () => els.review.close();
els.review.onclick = (e) => {
  if (e.target === els.review) els.review.close(); // backdrop click
};
els.reviewWrite.onclick = () => {
  els.review.close();
  void doWrite();
};

els.customUse.onclick = useCustomPath;
els.customPath.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    useCustomPath();
  }
};

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!els.save.disabled) save();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// drag & drop anywhere
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  els.dropveil.hidden = false;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropveil.hidden = true;
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropveil.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  // Handle must be requested synchronously inside the event; resolve later.
  const handle = e.dataTransfer ? handleFromDrop(e.dataTransfer) : Promise.resolve(null);
  void handle.then((h) => loadFile(f, h));
});
