import { useState } from "react";
import { isInRecycleBin, useDatabaseStore } from "@/stores/databaseStore";
import type { GroupNode } from "@/services/tauri";
import { VaultIcon } from "@/lib/icons";
import { PromptDialog } from "./PromptDialog";
import { ConfirmDialog } from "./ConfirmDialog";

/** MIME-ish keys used to identify drag payloads in the tree. */
export const DND_ENTRY = "application/x-vault-entry";
export const DND_GROUP = "application/x-vault-group";

type Dialog =
  | { kind: "create"; parent: GroupNode }
  | { kind: "rename"; group: GroupNode }
  | { kind: "delete"; group: GroupNode }
  | { kind: "deletePermanent"; group: GroupNode }
  | { kind: "empty"; group: GroupNode }
  | null;

/**
 * Collapsible group tree (PLAN Phase 3: sidebar with group tree, create/rename/
 * delete, and drag-and-drop targets for moving entries/groups).
 */
export function GroupTree() {
  const tree = useDatabaseStore((s) => s.tree);
  const selectedGroupUuid = useDatabaseStore((s) => s.selectedGroupUuid);
  const selectGroup = useDatabaseStore((s) => s.selectGroup);
  const createGroup = useDatabaseStore((s) => s.createGroup);
  const renameGroup = useDatabaseStore((s) => s.renameGroup);
  const deleteGroup = useDatabaseStore((s) => s.deleteGroup);
  const restoreGroup = useDatabaseStore((s) => s.restoreGroup);
  const emptyRecycleBin = useDatabaseStore((s) => s.emptyRecycleBin);
  const moveEntry = useDatabaseStore((s) => s.moveEntry);
  const moveGroup = useDatabaseStore((s) => s.moveGroup);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  if (!tree) return null;

  function toggle(uuid: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(uuid) ? next.delete(uuid) : next.add(uuid);
      return next;
    });
  }

  async function handleDrop(target: GroupNode, e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(null);
    const entryUuid = e.dataTransfer.getData(DND_ENTRY);
    if (entryUuid) {
      await moveEntry(entryUuid, target.uuid).catch(() => {});
      return;
    }
    const groupUuid = e.dataTransfer.getData(DND_GROUP);
    if (groupUuid && groupUuid !== target.uuid) {
      await moveGroup(groupUuid, target.uuid).catch(() => {});
    }
  }

  const renderNode = (node: GroupNode, depth: number) => {
    const isRoot = node.uuid === tree.root.uuid;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.uuid);
    const selected = node.uuid === selectedGroupUuid;
    const isDropTarget = dropTarget === node.uuid;
    // A group sitting inside (but not equal to) the recycle bin.
    const trashed = !node.isRecycleBin && isInRecycleBin(tree, node.uuid);

    return (
      <div key={node.uuid}>
        <div
          className={`group/row flex items-center gap-1 rounded-md pr-1 transition-colors ${
            selected ? "bg-accent-mint-dim" : "hover:bg-surface-elevated"
          } ${isDropTarget ? "ring-1 ring-accent-mint" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
          draggable={!isRoot}
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_GROUP, node.uuid);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(node.uuid);
          }}
          onDragLeave={() => setDropTarget((t) => (t === node.uuid ? null : t))}
          onDrop={(e) => handleDrop(node, e)}
        >
          <button
            type="button"
            onClick={() => hasChildren && toggle(node.uuid)}
            className={`grid h-5 w-5 shrink-0 place-items-center text-text-muted ${
              hasChildren ? "" : "invisible"
            }`}
            aria-label={isCollapsed ? "Expand" : "Collapse"}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              aria-hidden
            >
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => selectGroup(node.uuid)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          >
            <span className={selected ? "text-accent-mint" : "text-text-muted"}>
              <VaultIcon icon={node.isRecycleBin ? 43 : node.icon ?? 48} size={16} />
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-sm ${
                selected ? "font-medium text-text-primary" : "text-text-secondary"
              }`}
            >
              {isRoot ? node.name || "Database" : node.name || "Unnamed"}
            </span>
            {node.totalEntryCount > 0 && (
              <span className="shrink-0 text-xs text-text-muted">
                {node.totalEntryCount}
              </span>
            )}
          </button>

          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100">
            {node.isRecycleBin ? (
              <RowButton
                label="Empty recycle bin"
                danger
                onClick={() => setDialog({ kind: "empty", group: node })}
              >
                <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </RowButton>
            ) : trashed ? (
              <>
                <RowButton label="Restore group" onClick={() => void restoreGroup(node.uuid)}>
                  <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v3.5h3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </RowButton>
                <RowButton
                  label="Delete permanently"
                  danger
                  onClick={() => setDialog({ kind: "deletePermanent", group: node })}
                >
                  <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </RowButton>
              </>
            ) : (
              <>
                <RowButton
                  label="New subgroup"
                  onClick={() => setDialog({ kind: "create", parent: node })}
                >
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </RowButton>
                {!isRoot && (
                  <>
                    <RowButton
                      label="Rename group"
                      onClick={() => setDialog({ kind: "rename", group: node })}
                    >
                      <path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L4 18v2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    </RowButton>
                    <RowButton
                      label="Delete group"
                      danger
                      onClick={() => setDialog({ kind: "delete", group: node })}
                    >
                      <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </RowButton>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {hasChildren && !isCollapsed && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Groups
        </span>
        <button
          type="button"
          onClick={() => setDialog({ kind: "create", parent: tree.root })}
          aria-label="New group"
          title="New group at root"
          className="grid h-6 w-6 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-accent-mint"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-3">{renderNode(tree.root, 0)}</div>

      {dialog?.kind === "create" && (
        <PromptDialog
          title="New Group"
          label={`Create a group inside "${dialog.parent.name || "Database"}"`}
          placeholder="Group name"
          confirmLabel="Create"
          onConfirm={async (name) => {
            await createGroup(dialog.parent.uuid, name);
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(dialog.parent.uuid);
              return next;
            });
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "rename" && (
        <PromptDialog
          title="Rename Group"
          label="Group name"
          initialValue={dialog.group.name}
          onConfirm={async (name) => {
            await renameGroup(dialog.group.uuid, name);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete Group"
          message={`Move "${dialog.group.name || "this group"}" and all ${
            dialog.group.totalEntryCount
          } entr${dialog.group.totalEntryCount === 1 ? "y" : "ies"} inside it to the recycle bin?`}
          confirmLabel="Move to Recycle Bin"
          destructive
          onConfirm={async () => {
            await deleteGroup(dialog.group.uuid);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "deletePermanent" && (
        <ConfirmDialog
          title="Delete Permanently"
          message={`Permanently delete "${dialog.group.name || "this group"}" and everything inside it? This cannot be undone.`}
          confirmLabel="Delete Forever"
          destructive
          onConfirm={async () => {
            await deleteGroup(dialog.group.uuid, true);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "empty" && (
        <ConfirmDialog
          title="Empty Recycle Bin"
          message="Permanently delete everything in the recycle bin? This cannot be undone."
          confirmLabel="Empty Recycle Bin"
          destructive
          onConfirm={async () => {
            await emptyRecycleBin();
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function RowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-card ${
        danger ? "hover:text-status-error" : "hover:text-accent-mint"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
