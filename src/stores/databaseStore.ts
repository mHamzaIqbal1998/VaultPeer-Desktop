import { create } from "zustand";
import {
  allTags as svcAllTags,
  createEntry as svcCreateEntry,
  createGroup as svcCreateGroup,
  deleteEntry as svcDeleteEntry,
  deleteGroup as svcDeleteGroup,
  emptyRecycleBin as svcEmptyRecycleBin,
  getDatabaseTree,
  listEntries,
  moveEntry as svcMoveEntry,
  moveGroup as svcMoveGroup,
  renameGroup as svcRenameGroup,
  restoreEntry as svcRestoreEntry,
  restoreGroup as svcRestoreGroup,
  updateEntry as svcUpdateEntry,
  type DatabaseTree,
  type EntryInput,
  type EntrySummary,
  type GroupNode,
} from "@/services/tauri";
import { useSessionStore } from "./sessionStore";

export type ViewMode = "card" | "list";
export type SortKey = "title" | "created" | "modified";
export type SortDir = "asc" | "desc";

interface DatabaseState {
  tree: DatabaseTree | null;
  /** UUID of the group whose entries are shown; null until the tree loads. */
  selectedGroupUuid: string | null;
  entries: EntrySummary[];
  /** UUID of the entry open in the detail pane, or null. */
  selectedEntryUuid: string | null;
  /** All distinct tags in the database (for autocomplete + the filter chips). */
  tags: string[];
  /** Active tag filter applied to the entry list, or null for no filter. */
  tagFilter: string | null;

  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;

  loadingTree: boolean;
  loadingEntries: boolean;
  error: string | null;

  /** Load the tree and select the root group (called on unlock). */
  init: () => Promise<void>;
  /** Clear all loaded state (called on lock). */
  reset: () => void;

  selectGroup: (uuid: string) => Promise<void>;
  selectEntry: (uuid: string | null) => void;
  /** Reveal an entry: switch to its group (loading entries) then select it. */
  openEntry: (groupUuid: string, entryUuid: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshEntries: () => Promise<void>;
  refreshTags: () => Promise<void>;

  setView: (view: ViewMode) => void;
  setSort: (key: SortKey) => void;
  setTagFilter: (tag: string | null) => void;

  // Mutations — each persists in-memory, marks the session dirty, and refreshes.
  createEntry: (groupUuid: string, input: EntryInput) => Promise<string>;
  updateEntry: (entryUuid: string, input: EntryInput) => Promise<void>;
  deleteEntry: (entryUuid: string, permanent?: boolean) => Promise<void>;
  restoreEntry: (entryUuid: string) => Promise<void>;
  moveEntry: (entryUuid: string, targetGroupUuid: string) => Promise<void>;
  createGroup: (parentUuid: string, name: string) => Promise<string>;
  renameGroup: (groupUuid: string, name: string) => Promise<void>;
  deleteGroup: (groupUuid: string, permanent?: boolean) => Promise<void>;
  restoreGroup: (groupUuid: string) => Promise<void>;
  moveGroup: (groupUuid: string, targetGroupUuid: string) => Promise<void>;
  emptyRecycleBin: () => Promise<void>;
}

/** True if `uuid` is the recycle bin group or lives anywhere inside it. */
export function isInRecycleBin(tree: DatabaseTree | null, uuid: string): boolean {
  if (!tree?.recycleBinUuid) return false;
  const bin = findGroup(tree.root, tree.recycleBinUuid);
  return !!findGroup(bin, uuid);
}

function markDirty() {
  useSessionStore.getState().setDirty(true);
}

/** Walk the tree to find a group node by UUID. */
export function findGroup(node: GroupNode | null, uuid: string): GroupNode | null {
  if (!node) return null;
  if (node.uuid === uuid) return node;
  for (const child of node.children) {
    const found = findGroup(child, uuid);
    if (found) return found;
  }
  return null;
}

/** Build the breadcrumb path (root → … → group) for a group UUID. */
export function groupPath(root: GroupNode | null, uuid: string): GroupNode[] {
  if (!root) return [];
  const path: GroupNode[] = [];
  const walk = (node: GroupNode): boolean => {
    path.push(node);
    if (node.uuid === uuid) return true;
    for (const child of node.children) {
      if (walk(child)) return true;
    }
    path.pop();
    return false;
  };
  walk(root);
  return path;
}

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  tree: null,
  selectedGroupUuid: null,
  entries: [],
  selectedEntryUuid: null,
  tags: [],
  tagFilter: null,
  view: "card",
  sortKey: "title",
  sortDir: "asc",
  loadingTree: false,
  loadingEntries: false,
  error: null,

  init: async () => {
    set({ loadingTree: true, error: null });
    try {
      const tree = await getDatabaseTree();
      set({ tree, selectedGroupUuid: tree.root.uuid, selectedEntryUuid: null });
      await Promise.all([get().refreshEntries(), get().refreshTags()]);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loadingTree: false });
    }
  },

  reset: () =>
    set({
      tree: null,
      selectedGroupUuid: null,
      entries: [],
      selectedEntryUuid: null,
      tags: [],
      tagFilter: null,
      error: null,
    }),

  selectGroup: async (uuid) => {
    set({ selectedGroupUuid: uuid, selectedEntryUuid: null });
    await get().refreshEntries();
  },

  selectEntry: (uuid) => set({ selectedEntryUuid: uuid }),

  openEntry: async (groupUuid, entryUuid) => {
    if (get().selectedGroupUuid !== groupUuid) {
      await get().selectGroup(groupUuid);
    }
    set({ selectedEntryUuid: entryUuid });
  },

  refreshTree: async () => {
    try {
      const tree = await getDatabaseTree();
      set({ tree });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  refreshEntries: async () => {
    const groupUuid = get().selectedGroupUuid;
    if (!groupUuid) {
      set({ entries: [] });
      return;
    }
    set({ loadingEntries: true });
    try {
      const entries = await listEntries(groupUuid);
      // Drop the detail selection if the entry no longer lives in this group.
      const sel = get().selectedEntryUuid;
      const stillHere = sel ? entries.some((e) => e.uuid === sel) : false;
      set({ entries, selectedEntryUuid: stillHere ? sel : null });
    } catch (e) {
      set({ error: String(e), entries: [] });
    } finally {
      set({ loadingEntries: false });
    }
  },

  refreshTags: async () => {
    try {
      set({ tags: await svcAllTags() });
    } catch {
      /* tags are non-critical; ignore */
    }
  },

  setView: (view) => set({ view }),
  setSort: (key) =>
    set((s) =>
      s.sortKey === key
        ? { sortDir: s.sortDir === "asc" ? "desc" : "asc" }
        : { sortKey: key, sortDir: "asc" },
    ),
  setTagFilter: (tag) => set({ tagFilter: tag }),

  createEntry: async (groupUuid, input) => {
    const detail = await svcCreateEntry(groupUuid, input);
    markDirty();
    await Promise.all([
      get().refreshEntries(),
      get().refreshTree(),
      get().refreshTags(),
    ]);
    set({ selectedEntryUuid: detail.uuid });
    return detail.uuid;
  },

  updateEntry: async (entryUuid, input) => {
    await svcUpdateEntry(entryUuid, input);
    markDirty();
    await Promise.all([get().refreshEntries(), get().refreshTags()]);
  },

  deleteEntry: async (entryUuid, permanent = false) => {
    await svcDeleteEntry(entryUuid, permanent);
    markDirty();
    if (get().selectedEntryUuid === entryUuid) set({ selectedEntryUuid: null });
    await Promise.all([
      get().refreshEntries(),
      get().refreshTree(),
      get().refreshTags(),
    ]);
  },

  restoreEntry: async (entryUuid) => {
    await svcRestoreEntry(entryUuid);
    markDirty();
    if (get().selectedEntryUuid === entryUuid) set({ selectedEntryUuid: null });
    await Promise.all([get().refreshEntries(), get().refreshTree()]);
  },

  moveEntry: async (entryUuid, targetGroupUuid) => {
    await svcMoveEntry(entryUuid, targetGroupUuid);
    markDirty();
    await Promise.all([get().refreshEntries(), get().refreshTree()]);
  },

  createGroup: async (parentUuid, name) => {
    const uuid = await svcCreateGroup(parentUuid, name);
    markDirty();
    await get().refreshTree();
    return uuid;
  },

  renameGroup: async (groupUuid, name) => {
    await svcRenameGroup(groupUuid, name);
    markDirty();
    await get().refreshTree();
  },

  deleteGroup: async (groupUuid, permanent = false) => {
    await svcDeleteGroup(groupUuid, permanent);
    markDirty();
    // A soft delete relocates the group rather than removing it, so the current
    // selection only needs to fall back to root on a permanent delete.
    const { tree, selectedGroupUuid } = get();
    const selectionRemoved =
      permanent &&
      selectedGroupUuid &&
      isInSubtree(tree?.root ?? null, groupUuid, selectedGroupUuid);
    await Promise.all([get().refreshTree(), get().refreshEntries()]);
    if (selectionRemoved) {
      const rootUuid = get().tree?.root.uuid;
      if (rootUuid) await get().selectGroup(rootUuid);
    }
  },

  restoreGroup: async (groupUuid) => {
    await svcRestoreGroup(groupUuid);
    markDirty();
    await Promise.all([get().refreshTree(), get().refreshEntries()]);
  },

  moveGroup: async (groupUuid, targetGroupUuid) => {
    await svcMoveGroup(groupUuid, targetGroupUuid);
    markDirty();
    await get().refreshTree();
  },

  emptyRecycleBin: async () => {
    await svcEmptyRecycleBin();
    markDirty();
    if (get().selectedEntryUuid) set({ selectedEntryUuid: null });
    await Promise.all([
      get().refreshTree(),
      get().refreshEntries(),
      get().refreshTags(),
    ]);
  },
}));

/** True if `needle` is `ancestor` or lives anywhere beneath it. */
function isInSubtree(
  root: GroupNode | null,
  ancestor: string,
  needle: string,
): boolean {
  const node = findGroup(root, ancestor);
  return !!findGroup(node, needle);
}
