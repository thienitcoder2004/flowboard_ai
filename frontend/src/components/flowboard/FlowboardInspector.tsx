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
  onGenerateWithQuality: (nodeId?: string, videoQuality?: "2k" | "4k") => void | Promise<void>;
  onOpenStoryboardPreview: (nodeId: string) => void | Promise<void>;
  onDownloadSelectedVideo: () => void | Promise<void>;
  onPatchNodeData: (nodeId: string, data: Record<string, unknown>) => void | Promise<unknown>;
  onDeleteSelection: () => void | Promise<void>;
};

export default function FlowboardInspector({
  selectedNode,
  selectedEdge,
  draftPrompt,
  onDraftPromptChange,
  onSavePrompt,
  onGenerateWithQuality,
  onOpenStoryboardPreview,
  onDownloadSelectedVideo,
  onPatchNodeData,
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
  const primaryMediaId = mediaId || posterMediaId || selectedData?.mediaIds?.[0] || selectedData?.data?.mediaIds?.[0] || "";
  const mediaIds = selectedData?.mediaIds || selectedData?.data?.mediaIds || [];
  const mediaUrls = selectedData?.mediaUrls || selectedData?.data?.mediaUrls || [];
  const storyboardShots = (mediaUrls.length > 0 ? mediaUrls : mediaIds.map((id) => mediaUrl(id))).filter(Boolean).slice(0, 2);
  const [videoQuality, setVideoQuality] = useState<"2k" | "4k">(
    (selectedData?.videoQuality ?? selectedData?.data?.videoQuality ?? "2k") as "2k" | "4k",
  );

  useEffect(() => {
    setVideoQuality((selectedData?.videoQuality ?? selectedData?.data?.videoQuality ?? "2k") as "2k" | "4k");
  }, [selectedNode?.id, selectedData?.videoQuality, selectedData?.data?.videoQuality]);

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
            <button onClick={() => void onGenerateWithQuality(selectedNode?.id, videoQuality)}>
              <Cable size={15} /> Send Google Flow
            </button>
            <button className="danger" onClick={() => void onDeleteSelection()}>
              <Trash2 size={15} /> Xóa node
            </button>
          </div>

          {selectedData.kind === "video" ? (
            <>
              <label>Video chất lượng</label>
              <select
                value={videoQuality}
                onChange={(event) => {
                  const next = event.target.value as "2k" | "4k";
                  setVideoQuality(next);
                  void onPatchNodeData(selectedNode!.id, {
                    videoQuality: next,
                  });
                }}
              >
                <option value="2k">2K</option>
                <option value="4k">4K</option>
              </select>
            </>
          ) : null}

          {waitingLabel ? <div className="empty">{waitingLabel}</div> : null}

          {selectedData.kind === "storyboard" ? (
            <div className="storyboard-inspector-preview">
              {storyboardShots.map((src, index) => (
                <button
                  key={`${src}-${index}`}
                  type="button"
                  className="storyboard-inspector-shot-button"
                  onClick={() => void onOpenStoryboardPreview(selectedNode!.id)}
                  title="Mở storyboard"
                >
                  <img
                    className="asset-preview storyboard-inspector-shot"
                    src={src}
                    alt={`${selectedData.title} ${index + 1}`}
                  />
                </button>
              ))}
            </div>
          ) : null}

          {selectedData.kind === "storyboard" ? (
            <button type="button" className="secondary-action" onClick={() => void onOpenStoryboardPreview(selectedNode!.id)}>
              Xem storyboard lớn
            </button>
          ) : null}

          {selectedData.kind === "storyboard" ? (
            <div className="empty">Storyboard đã nhận được {storyboardShots.length} ảnh ghép.</div>
          ) : null}

          {selectedData.kind === "video" && typeof selectedData.output === "object" && selectedData.output !== null && typeof (selectedData.output as { videoUrl?: unknown }).videoUrl === "string" ? (
            <div className="empty">
              <video
                className="asset-preview video-preview"
                controls
                src={String((selectedData.output as { videoUrl?: unknown }).videoUrl)}
              />
              <a href={String((selectedData.output as { videoUrl?: unknown }).videoUrl)} target="_blank" rel="noreferrer">
                Tải video
              </a>
              <button type="button" className="secondary-action" onClick={() => void onDownloadSelectedVideo()}>
                Tải video về máy
              </button>
            </div>
          ) : selectedData.kind !== "storyboard" && primaryMediaId ? (
            <div className="empty">
              {selectedData.kind === "video" ? (
                <video className="asset-preview video-preview" controls src={mediaUrl(primaryMediaId)} />
              ) : (
                <img
                  className="asset-preview"
                  src={mediaUrl(primaryMediaId)}
                  alt={selectedData.title}
                />
              )}
              {selectedData.kind === "video" && typeof selectedData.output === "object" && selectedData.output !== null && typeof (selectedData.output as { videoUrl?: unknown }).videoUrl === "string" ? (
                <a href={String((selectedData.output as { videoUrl?: unknown }).videoUrl)} target="_blank" rel="noreferrer">
                  Tải video
                </a>
              ) : null}
              {selectedData.kind === "video" ? (
                <button type="button" className="secondary-action" onClick={() => void onDownloadSelectedVideo()}>
                  Tải video về máy
                </button>
              ) : null}
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
