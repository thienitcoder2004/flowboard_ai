import { useEffect, useState } from "react";
import { Cable, Trash2 } from "lucide-react";
import type { Edge } from "@xyflow/react";
import { mediaUrl } from "./flowboardHelpers";
import type { FlowNodeType } from "./flowboardTypes";

type Props = {
  selectedNode: FlowNodeType | null;
  selectedEdge: Edge | null;
  draftPrompt: string;
  onDraftPromptChange: (value: string) => void;
  onSavePrompt: (nodeId?: string, prompt?: string) => void | Promise<unknown>;
  onGenerateGoogleFlow: (nodeId?: string) => void | Promise<void>;
  onDeleteSelection: () => void | Promise<void>;
};

export default function FlowboardInspector({
  selectedNode,
  selectedEdge,
  draftPrompt,
  onDraftPromptChange,
  onSavePrompt,
  onGenerateGoogleFlow,
  onDeleteSelection,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const selectedData = selectedNode?.data;
  const waitingSince =
    selectedData?.waitingSince || selectedData?.data?.waitingSince || "";
  const timeoutMs = Number(
    selectedData?.requestTimeoutMs ||
      selectedData?.data?.requestTimeoutMs ||
      60000,
  );
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const waitingElapsed = waitingSince
    ? Math.max(0, now - new Date(waitingSince).getTime())
    : 0;
  const waitingLabel =
    selectedData?.requestState === "waiting"
      ? waitingElapsed >= timeoutMs
        ? `Đã chờ ${Math.ceil(waitingElapsed / 1000)}s (quá ${Math.ceil(timeoutMs / 1000)}s)`
        : `Đang chờ Google Flow… khoảng ${Math.ceil(waitingElapsed / 1000)}s / ${Math.ceil(timeoutMs / 1000)}s`
      : "";
  const mediaId = selectedData?.mediaId || selectedData?.data?.mediaId || "";
  const posterMediaId = selectedData?.posterMediaId || selectedData?.data?.posterMediaId || "";

  return (
    <aside className="inspector">
      <div className="panel-title">Inspector</div>

      {selectedEdge ? (
        <>
          <label>Edge đang chọn</label>
          <h3>
            {selectedEdge.source.slice(0, 4)} →{" "}
            {selectedEdge.target.slice(0, 4)}
          </h3>

          <button className="danger" onClick={() => void onDeleteSelection()}>
            <Trash2 size={15} /> Xóa dây nối
          </button>
        </>
      ) : selectedData ? (
        <>
          <label>Node đang chọn</label>
          <h3>{selectedData.title}</h3>

          <label>Prompt</label>
          <textarea
            value={draftPrompt}
            onChange={(event) => onDraftPromptChange(event.target.value)}
            placeholder="Nhập prompt cho node này"
          />

          <div className="actions">
            <button onClick={() => void onSavePrompt(selectedNode?.id)}>
              Save prompt
            </button>
            <button onClick={() => void onGenerateGoogleFlow(selectedNode?.id)}>
              <Cable size={15} /> Send Google Flow
            </button>
            <button className="danger" onClick={() => void onDeleteSelection()}>
              <Trash2 size={15} /> Xóa node
            </button>
          </div>

          {waitingLabel ? <div className="empty">{waitingLabel}</div> : null}

          {(mediaId || posterMediaId) ? (
            <div className="empty">
              <img
                className="asset-preview"
                src={mediaUrl(mediaId || posterMediaId)}
                alt={selectedData.title}
              />
            </div>
          ) : null}

          <label>Output</label>
          <pre>{JSON.stringify(selectedData.output || {}, null, 2)}</pre>
        </>
      ) : (
        <div className="empty">
          Chọn một node hoặc dây nối để chỉnh prompt, generate hoặc xóa. Chuột
          phải trên canvas để thêm input, Storyboard hoặc Video.
        </div>
      )}
    </aside>
  );
}
