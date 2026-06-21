import { create } from "zustand";
import {
  createEntry as svcCreateEntry,
  createGroup as svcCreateGroup,
  deleteEntry as svcDeleteEntry,
  deleteGroup as svcDeleteGroup,
  getDatabaseTree,
  listEntries,
  moveEntry as svcMoveEntry,
  moveGroup as svcMoveGroup,
  renameGroup as svcRenameGroup,
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
  refreshTree: () => Promise<void>;
  refreshEntries: () => Promise<void>;

  setView: (view: ViewMode) => void;
  setSort: (key: SortKey) => void;

  // Mutations — each persists in-memory, marks the session dirty, and refreshes.
  createEntry: (groupUuid: string, input: EntryInput) => Promise<string>;
  updateEntry: (entryUuid: string, input: EntryInput) => Promise<void>;
  deleteEntry: (entryUuid: string) => Promise<void>;
  moveEntry: (entryUuid: string, targetGroupUuid: string) => Promise<void>;
  createGroup: (parentUuid: string, name: string) => Promise<string>;
  renameGroup: (groupUuid: string, name: string) => Promise<void>;
  deleteGroup: (groupUuid: string) => Promise<void>;
  moveGroup: (groupUuid: string, targetGroupUuid: string) => Promise<void>;
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
      await get().refreshEntries();
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
      error: null,
    }),

  selectGroup: async (uuid) => {
    set({ selectedGroupUuid: uuid, selectedEntryUuid: null });
    await get().refreshEntries();
  },

  selectEntry: (uuid) => set({ selectedEntryUuid: uuid }),

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

  setView: (view) => set({ view }),
  setSort: (key) =>
    set((s) =>
      s.sortKey === key
        ? { sortDir: s.sortDir === "asc" ? "desc" : "asc" }
        : { sortKey: key, sortDir: "asc" },
    ),

  createEntry: async (groupUuid, input) => {
    const detail = await svcCreateEntry(groupUuid, input);
    markDirty();
    await Promise.all([get().refreshEntries(), get().refreshTree()]);
    set({ selectedEntryUuid: detail.uuid });
    return detail.uuid;
  },

  updateEntry: async (entryUuid, input) => {
    await svcUpdateEntry(entryUuid, input);
    markDirty();
    await get().refreshEntries();
  },

  deleteEntry: async (entryUuid) => {
    await svcDeleteEntry(entryUuid);
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

  deleteGroup: async (groupUuid) => {
    await svcDeleteGroup(groupUuid);
    markDirty();
    // If the deleted group (or a descendant) was selected, fall back to root.
    const { tree, selectedGroupUuid } = get();
    const stillExists =
      selectedGroupUuid &&
      findGroup(tree?.root ?? null, selectedGroupUuid) &&
      !isInSubtree(tree?.root ?? null, groupUuid, selectedGroupUuid);
    await get().refreshTree();
    if (!stillExists) {
      const rootUuid = get().tree?.root.uuid;
      if (rootUuid) await get().selectGroup(rootUuid);
    }
  },

  moveGroup: async (groupUuid, targetGroupUuid) => {
    await svcMoveGroup(groupUuid, targetGroupUuid);
    markDirty();
    await get().refreshTree();
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
