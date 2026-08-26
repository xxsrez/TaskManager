"use client";

import {
  Archive,
  ArchiveRestore,
  ExternalLink,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  nextContextualActionIndex,
  type ResolvedContextualAction,
} from "@/lib/contextual-actions";

const menuIcon = {
  open: ExternalLink,
  edit: Pencil,
  share: Share2,
  archive: Archive,
  restore: ArchiveRestore,
  delete: Trash2,
};

export function ContextualActionMenu({
  actions,
  x,
  y,
  busy,
  onExecute,
  onClose,
}: {
  actions: ResolvedContextualAction[];
  x: number;
  y: number;
  busy: boolean;
  onExecute: (action: ResolvedContextualAction) => void | Promise<void>;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, actions.findIndex((action) => !action.disabledReason)),
  );
  const [confirmation, setConfirmation] = useState<ResolvedContextualAction | null>(null);

  useEffect(() => {
    itemRefs.current[activeIndex]?.focus();
  }, [activeIndex, confirmation]);

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [onClose]);

  async function execute(action: ResolvedContextualAction) {
    if (action.disabledReason || busy) return;
    if (action.confirmation && confirmation !== action) {
      setConfirmation(action);
      return;
    }
    await onExecute(action);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirmation) setConfirmation(null);
      else onClose();
      return;
    }
    if (confirmation) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => nextContextualActionIndex(
        actions,
        current,
        event.key === "ArrowDown" ? 1 : -1,
      ));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const candidates = actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => !action.disabledReason);
      const next = event.key === "Home" ? candidates[0] : candidates.at(-1);
      if (next) setActiveIndex(next.index);
    }
  }

  return (
    <div
      ref={menuRef}
      className="contextual-action-menu"
      style={{
        left: `clamp(8px, ${Math.max(8, x)}px, calc(100vw - 248px))`,
        top: `clamp(8px, ${Math.max(8, y)}px, calc(100vh - 248px))`,
      }}
      role={confirmation ? "alertdialog" : "menu"}
      aria-label={confirmation ? "Confirm contextual action" : "Contextual actions"}
      aria-modal="true"
      onKeyDown={handleKeyDown}
    >
      {confirmation ? (
        <div className="contextual-action-confirmation">
          <p>{confirmation.confirmation}</p>
          <div>
            <button type="button" className="button ghost compact" autoFocus onClick={() => setConfirmation(null)}>Cancel</button>
            <button type="button" className="button danger compact" disabled={busy} onClick={() => void execute(confirmation)}>{busy ? "Working…" : "Confirm"}</button>
          </div>
        </div>
      ) : actions.map((action, index) => {
        const Icon = menuIcon[action.icon];
        return (
          <button
            key={action.id}
            ref={(node) => { itemRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            className={action.destructive ? "danger" : undefined}
            aria-disabled={Boolean(action.disabledReason || busy)}
            title={action.disabledReason ?? undefined}
            tabIndex={index === activeIndex ? 0 : -1}
            onMouseEnter={() => { if (!action.disabledReason) setActiveIndex(index); }}
            onClick={() => void execute(action)}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{action.label}</span>
            {action.shortcut && <kbd>{action.shortcut}</kbd>}
            {action.disabledReason && <small>{action.disabledReason}</small>}
          </button>
        );
      })}
    </div>
  );
}
