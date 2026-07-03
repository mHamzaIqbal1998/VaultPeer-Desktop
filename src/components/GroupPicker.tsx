import { useEffect, useRef, useState } from "react";
import { useDatabaseStore, groupPath } from "@/stores/databaseStore";
import { VaultIcon } from "@/lib/icons";
import type { GroupNode } from "@/services/tauri";

interface Props {
  /** Currently selected group UUID. */
  value: string;
  onChange: (groupUuid: string) => void;
}

/**
 * Compact group/folder picker. Shows the current group path as a breadcrumb
 * button that opens a tree popover for relocating an entry during create/edit.
 * Visually mirrors the IconPicker pattern.
 */
export function GroupPicker({ value, onChange }: Props) {
  const tree = useDatabaseStore((s) => s.tree);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!tree) return null;

  // Build the display path string from the breadcrumb.
  const breadcrumb = groupPath(tree.root, value);
  const pathStr =
    breadcrumb.length <= 1
      ? "/"
      : "/" + breadcrumb.slice(1).map((g) => g.name || "Unnamed").join("/");

  return (
    <div ref={ref} className="relative flex-1">
      <span className="mb-1.5 block text-xs font-medium text-text-muted">Location</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Choose group"
        title="Choose group / folder"
        className="flex h-11 w-full items-center gap-2 rounded-lg border border-border-sage bg-background-primary px-3 text-sm text-text-primary transition-colors hover:border-accent-mint/50"
      >
        <span className="shrink-0 text-text-muted">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7H3Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{pathStr}</span>
        <span className="shrink-0 text-text-muted">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-[4.5rem] z-50 max-h-64 w-full overflow-auto rounded-xl border border-border-sage bg-surface-elevated p-2 shadow-2xl">
          <GroupTreeNode
            node={tree.root}
            depth={0}
            selected={value}
            recycleBinUuid={tree.recycleBinUuid}
            onSelect={(uuid) => {
              onChange(uuid);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function GroupTreeNode({
  node,
  depth,
  selected,
  recycleBinUuid,
  onSelect,
}: {
  node: GroupNode;
  depth: number;
  selected: string;
  recycleBinUuid: string | null;
  onSelect: (uuid: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isRecycleBin = node.uuid === recycleBinUuid || node.isRecycleBin;
  const isRoot = depth === 0;
  const hasChildren = node.children.filter((c) => !c.isRecycleBin && c.uuid !== recycleBinUuid).length > 0;
  const active = node.uuid === selected;

  // Don't render the recycle bin as a selectable target.
  if (isRecycleBin && !isRoot) return null;

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-md transition-colors ${
          active
            ? "bg-accent-mint-dim text-accent-mint"
            : "text-text-secondary hover:bg-surface-card hover:text-text-primary"
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className={`grid h-5 w-5 shrink-0 place-items-center text-text-muted ${
            hasChildren ? "" : "invisible"
          }`}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => onSelect(node.uuid)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm"
        >
          <VaultIcon icon={node.icon ?? 48} size={14} />
          <span className="truncate">
            {isRoot ? node.name || "Root" : node.name || "Unnamed"}
          </span>
        </button>
      </div>

      {expanded &&
        hasChildren &&
        node.children
          .filter((c) => !c.isRecycleBin && c.uuid !== recycleBinUuid)
          .map((child) => (
            <GroupTreeNode
              key={child.uuid}
              node={child}
              depth={depth + 1}
              selected={selected}
              recycleBinUuid={recycleBinUuid}
              onSelect={onSelect}
            />
          ))}
    </div>
  );
}
