import React, { useCallback, useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Video } from "lucide-react";
import { KIND_META, mediaUrl } from "./flowboardHelpers";
import type { FlowboardNodeActionDetail, FlowNodeType, Kind } from "./flowboardTypes";

type FlowNodeProps = NodeProps<FlowNodeType>;

export default function FlowboardNode({ id, data, selected }: FlowNodeProps) {
  const [now, setNow] = useState(() => Date.now());
  const [previewAspectRatio, setPreviewAspectRatio] = useState<number | null>(null);

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
  const isFeaturedKind = kind === "script" || kind === "scriptboard" || kind === "segment" || kind === "character" || kind === "scene" || kind === "storyboard" || kind === "video" || kind === "merge";
  const reference =
    typeof nodeData.reference === "string"
      ? nodeData.reference
      : typeof nodeData.data?.reference === "string"
        ? nodeData.data.reference
        : undefined;
  const mediaId = nodeData.mediaId || nodeData.data?.mediaId || undefined;
  const posterMediaId = nodeData.posterMediaId || nodeData.data?.posterMediaId || undefined;
  const mediaIds = nodeData.mediaIds || nodeData.data?.mediaIds || [];
  const mediaUrls = nodeData.mediaUrls || nodeData.data?.mediaUrls || [];
  const primaryMediaId = mediaId || posterMediaId || mediaIds[0];
  const hasPreview = Boolean(primaryMediaId || reference || mediaUrls.length > 0);
  const storyboardPreviewSources = mediaUrls.length > 0 ? mediaUrls : mediaIds.map((item) => mediaUrl(item));
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
  const finalVideoUrl =
    typeof nodeData.output === "object" &&
    nodeData.output !== null &&
    typeof (nodeData.output as { finalVideoUrl?: unknown }).finalVideoUrl === "string"
      ? String((nodeData.output as { finalVideoUrl?: unknown }).finalVideoUrl)
      : "";
  const duration = Number(nodeData.duration || nodeData.data?.duration || 8);
  const previewSource =
    kind === "video"
      ? videoUrl || mediaUrl(posterMediaId || primaryMediaId)
      : kind === "storyboard"
        ? storyboardPreviewSources[0] || mediaUrl(primaryMediaId) || reference || ""
        : mediaUrl(primaryMediaId) || reference || mediaUrls[0] || "";

  useEffect(() => {
    if (!previewSource) {
      setPreviewAspectRatio(null);
      return;
    }

    let cancelled = false;
    setPreviewAspectRatio(null);

    if (kind === "video") {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        if (!cancelled && video.videoWidth > 0 && video.videoHeight > 0) {
          setPreviewAspectRatio(video.videoWidth / video.videoHeight);
        }
      };
      video.src = previewSource;
      video.load();

      return () => {
        cancelled = true;
        video.src = "";
      };
    }

    const image = new Image();
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setPreviewAspectRatio(image.naturalWidth / image.naturalHeight);
      }
    };
    image.src = previewSource;

    return () => {
      cancelled = true;
      image.src = "";
    };
  }, [kind, previewSource]);

  const previewStyle = previewAspectRatio ? ({ aspectRatio: `${previewAspectRatio}` } as React.CSSProperties) : undefined;
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
      className={`flow-node ${isFeaturedKind ? "flow-node--featured" : ""} kind-${kind} ${selected ? "selected" : ""} ${nodeData.status === "generating" ? "generating" : ""} ${nodeData.status === "done" ? "done" : ""} ${nodeData.status === "failed" ? "failed" : ""}`}
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
        {nodeData.prompt ? <div className="node-prompt-preview">{nodeData.prompt}</div> : null}
        {kind === "merge" ? (
          <div className="video-box">
            <Video size={34} />
            <span>{finalVideoUrl ? "Final ready" : "Merge"}</span>
            <button onClick={fire("generate")}>Generate</button>
            {finalVideoUrl ? (
              <video
                className="asset-preview dynamic-media-preview video-preview"
                style={previewStyle}
                controls
                src={finalVideoUrl}
              />
            ) : null}
            {finalVideoUrl ? (
              <a href={finalVideoUrl} target="_blank" rel="noreferrer" download>
                Play / Download
              </a>
            ) : null}
          </div>
        ) : kind === "video" ? (
          <div className="video-box">
            <Video size={34} />
            <span>
              {videoUrl || posterMediaId || mediaId
                ? duration >= 60
                  ? `${Math.round(duration / 60)}p`
                  : duration > 0
                    ? `${duration}s`
                    : "Ready"
                : "0:00"}
            </span>
            <button onClick={fire("generate")}>Generate</button>
            {(videoUrl || posterMediaId || primaryMediaId) ? (
              <video
                className="asset-preview dynamic-media-preview video-preview"
                style={previewStyle}
                controls
                src={videoUrl || mediaUrl(posterMediaId || primaryMediaId)}
              />
            ) : null}
            {(videoUrl || primaryMediaId) ? (
              <a href={videoUrl || mediaUrl(primaryMediaId)} target="_blank" rel="noreferrer" download>
                Play / Download
              </a>
            ) : null}
            {(videoUrl || primaryMediaId) ? (
              <a href={videoUrl || mediaUrl(primaryMediaId)} download>
                Tải video
              </a>
            ) : null}
          </div>
        ) : kind === "storyboard" ? (
          <div className="story-grid">
            {storyboardPreviewSources.length > 1 ? (
              <div className="story-preview-grid">
                {storyboardPreviewSources.slice(0, 2).map((src, index) => (
                  <button
                    key={`${src}-${index}`}
                    type="button"
                    className="storyboard-preview-button"
                    onClick={fire("preview-storyboard")}
                    title="Xem storyboard"
                  >
                    <img
                      className="asset-preview dynamic-media-preview storyboard-preview"
                      style={previewStyle}
                      src={src}
                      alt={`${nodeData.title} ${index + 1}`}
                    />
                  </button>
                ))}
              </div>
            ) : (primaryMediaId || reference) ? (
              <button
                type="button"
                className="storyboard-preview-button"
                onClick={fire("preview-storyboard")}
                title="Xem storyboard"
              >
                <img className="asset-preview dynamic-media-preview storyboard-preview" style={previewStyle} src={mediaUrl(primaryMediaId) || reference} alt={nodeData.title} />
              </button>
            ) : (
              <>
                <i />
                <i />
                <i />
                <i />
              </>
            )}
            <span>{(frames || storyboardPreviewSources.length || mediaIds.length || 4)} frames</span>
            <button onClick={fire("generate")}>Generate</button>
          </div>
        ) : (
          <div className={`image-box ${hasPreview ? "has-preview" : ""}`}>
            {hasPreview ? (
              <img
                className="asset-preview dynamic-media-preview image-preview-clickable"
                style={previewStyle}
                src={mediaUrl(primaryMediaId) || reference || mediaUrls[0]}
                alt={nodeData.title}
                onClick={fire("upload")}
                title="Click để thay ảnh"
              />
            ) : null}
            {!hasPreview ? (
              <>
                <button onClick={fire("upload")}>Upload</button>
                <button onClick={fire("generate")}>Generate</button>
              </>
            ) : null}
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
