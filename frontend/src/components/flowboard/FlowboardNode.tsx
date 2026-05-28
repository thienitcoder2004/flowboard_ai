import React, { useCallback, useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Video } from "lucide-react";
import { KIND_META, mediaUrl } from "./flowboardHelpers";
import type { FlowboardNodeActionDetail, FlowNodeType, Kind } from "./flowboardTypes";

type FlowNodeProps = NodeProps<FlowNodeType>;

export default function FlowboardNode({ id, data, selected }: FlowNodeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const nodeData = data ?? {
    id,
    kind: "note" as Kind,
    title: "Untitled",
    status: "ready",
  };

  const kind = nodeData.kind ?? "note";
  const meta = KIND_META[kind] ?? KIND_META.note;
  const Icon = meta.icon;
  const reference =
    typeof nodeData.reference === "string"
      ? nodeData.reference
      : typeof nodeData.data?.reference === "string"
        ? nodeData.data.reference
        : undefined;
  const mediaId = nodeData.mediaId || nodeData.data?.mediaId || undefined;
  const posterMediaId = nodeData.posterMediaId || nodeData.data?.posterMediaId || undefined;
  const mediaIds = nodeData.mediaIds || nodeData.data?.mediaIds || [];
  const outputLabel =
    typeof nodeData.output === "object" &&
    nodeData.output !== null &&
    "description" in nodeData.output
      ? String((nodeData.output as { description?: unknown }).description ?? "")
      : "";
  const frames =
    typeof nodeData.output === "object" &&
    nodeData.output !== null &&
    Array.isArray((nodeData.output as { frames?: unknown[] }).frames)
      ? ((nodeData.output as { frames?: unknown[] }).frames ?? []).length
      : 0;
  const videoUrl =
    typeof nodeData.output === "object" &&
    nodeData.output !== null &&
    typeof (nodeData.output as { videoUrl?: unknown }).videoUrl === "string"
      ? String((nodeData.output as { videoUrl?: unknown }).videoUrl)
      : "";
  const waitingSince = nodeData.waitingSince || nodeData.data?.waitingSince || "";
  const timeoutMs = Number(nodeData.requestTimeoutMs || nodeData.data?.requestTimeoutMs || 60000);
  const waitingElapsed = waitingSince ? Math.max(0, now - new Date(waitingSince).getTime()) : 0;
  const waitingLabel =
    nodeData.requestState === "waiting"
      ? waitingElapsed >= timeoutMs
        ? `Đã chờ ${Math.ceil(waitingElapsed / 1000)}s (quá ${Math.ceil(timeoutMs / 1000)}s)`
        : `Đang chờ Google Flow… ${Math.ceil(waitingElapsed / 1000)}s / ${Math.ceil(timeoutMs / 1000)}s`
      : nodeData.requestState === "timeout"
        ? `Quá ${Math.ceil(timeoutMs / 1000)}s`
        : "";

  const fire = useCallback(
    (type: FlowboardNodeActionDetail["type"]) => (event: React.MouseEvent) => {
      event.stopPropagation();
      window.dispatchEvent(
        new CustomEvent<FlowboardNodeActionDetail>("flowboard-node-action", {
          detail: { type, nodeId: id },
        }),
      );
    },
    [id],
  );

  return (
    <div
      className={`flow-node ${selected ? "selected" : ""} ${nodeData.status === "generating" ? "generating" : ""}`}
      style={{ "--node-accent": meta.color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="handle" />

      <div className="node-header">
        <div className="node-title">
          <Icon size={15} />
          <b>{nodeData.title}</b>
        </div>
        <span>#{String(id).slice(0, 4)}</span>
      </div>

      <div className="node-body" onClick={fire("select")}>
        {kind === "video" ? (
          <div className="video-box">
            <Video size={34} />
            <span>{videoUrl || posterMediaId || mediaId ? "Ready" : "0:00"}</span>
            <button onClick={fire("generate")}>Generate</button>
            {(posterMediaId || mediaId) ? (
              <img className="asset-preview video-preview" src={mediaUrl(posterMediaId || mediaId)} alt={nodeData.title} />
            ) : null}
            {(videoUrl || mediaId || posterMediaId) ? (
              <a href={videoUrl || mediaUrl(mediaId || posterMediaId)} target="_blank" rel="noreferrer">
                Play / Download
              </a>
            ) : null}
          </div>
        ) : kind === "storyboard" ? (
          <div className="story-grid">
            {(mediaId || reference) ? (
              <img className="asset-preview storyboard-preview" src={mediaUrl(mediaId) || reference} alt={nodeData.title} />
            ) : (
              <>
                <i />
                <i />
                <i />
                <i />
              </>
            )}
            <span>{(frames || mediaIds.length || 4)} frames</span>
            <button onClick={fire("generate")}>Generate</button>
          </div>
        ) : (
          <div className={`image-box ${mediaId || reference ? "has-preview" : ""}`}>
            {(mediaId || reference) ? (
              <img className="asset-preview" src={mediaUrl(mediaId) || reference} alt={nodeData.title} />
            ) : null}
            <button onClick={fire("upload")}>Upload</button>
            <button onClick={fire("generate")}>Generate</button>
          </div>
        )}
      </div>

      <div className="node-footer">
        <span className={`pill ${nodeData.status}`}>{nodeData.status}</span>
        {waitingLabel ? <span>{waitingLabel}</span> : null}
        <span>{outputLabel || "ready"}</span>
      </div>

      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}
