// File System Access helpers: open a save straight from disk and write it back
// in place, instead of the download-to-Downloads-then-copy-back dance.
// Chromium-only — every entry point feature-detects, and callers fall back to
// the <input type=file> + download flow elsewhere.

// The picker/drop-handle APIs aren't in lib.dom yet; declare the slice we use.
declare global {
  interface Window {
    showOpenFilePicker?(options?: {
      id?: string;
      types?: { description?: string; accept: Record<string, string[]> }[];
    }): Promise<FileSystemFileHandle[]>;
  }
  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
  interface FileSystemHandle {
    requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  }
}

export const canPickFiles = (): boolean => typeof window.showOpenFilePicker === "function";

// Returns null when unsupported or when the user cancels the picker.
export async function pickSave(): Promise<{ file: File; handle: FileSystemFileHandle } | null> {
  if (!window.showOpenFilePicker) return null;
  try {
    const [handle] = await window.showOpenFilePicker({
      id: "votv-saves", // remembers the last directory across visits
      types: [{ description: "VotV save", accept: { "application/octet-stream": [".sav"] } }],
    });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    throw e;
  }
}

// Must be invoked synchronously inside the drop event — the DataTransferItem
// is dead once the handler returns; only the returned promise may be awaited.
export function handleFromDrop(dt: DataTransfer): Promise<FileSystemFileHandle | null> {
  const item = dt.items?.[0];
  if (!item?.getAsFileSystemHandle) return Promise.resolve(null);
  return item
    .getAsFileSystemHandle()
    .then((h) => (h?.kind === "file" ? (h as FileSystemFileHandle) : null))
    .catch(() => null);
}

export async function writeInPlace(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  if (handle.requestPermission && (await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
    throw new Error("write permission not granted");
  }
  const stream = await handle.createWritable();
  await stream.write(new Uint8Array(bytes)); // private copy — write() may detach
  await stream.close();
}
