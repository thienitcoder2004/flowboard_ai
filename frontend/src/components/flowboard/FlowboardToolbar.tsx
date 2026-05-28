import type { ToolbarItem } from "./flowboardHelpers";
import type { ToolbarKind } from "./flowboardTypes";

type Props = {
  items: ToolbarItem[];
  onAddKind: (kind: ToolbarKind) => void | Promise<void>;
};

export default function FlowboardToolbar({ items, onAddKind }: Props) {
  return (
    <div className="toolbelt">
      {items.map(({ kind, label, icon: Icon }) => (
        <button key={kind} onClick={() => void onAddKind(kind)}>
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}
