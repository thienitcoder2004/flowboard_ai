import {
  Box,
  CircleUserRound,
  Palette,
  ImageIcon,
  Layers,
  FileText,
  GitBranch,
  MonitorPlay,
  Package,
  Route,
  Sparkles,
  Shirt,
  Video,
  type LucideIcon,
} from "lucide-react";
import type {
  FlowNodeType,
  Kind,
  ProjectNode,
  ToolbarKind,
} from "./flowboardTypes";

export const API = "http://127.0.0.1:8101";

export const mediaUrl = (mediaId?: string | null) => (mediaId ? `${API}/media/${mediaId}` : "");

export type ToolbarItem = {
  kind: ToolbarKind;
  label: string;
  icon: LucideIcon;
};

export const KIND_META: Record<Kind, { label: string; icon: LucideIcon; color: string }> = {
  character: { label: "Nhân vật", icon: CircleUserRound, color: "#ff4d6d" },
  scene: { label: "Cảnh", icon: MonitorPlay, color: "#38bdf8" },
  clothes: { label: "Quần áo", icon: Shirt, color: "#a78bfa" },
  accessory: { label: "Phụ kiện", icon: Package, color: "#fbbf24" },
  action: { label: "Hành động", icon: Sparkles, color: "#34d399" },
  style: { label: "Phong cách", icon: Palette, color: "#f97316" },
  image: { label: "Image", icon: ImageIcon, color: "#22c55e" },
  script: { label: "Script", icon: FileText, color: "#facc15" },
  scriptboard: { label: "Scriptboard", icon: GitBranch, color: "#38bdf8" },
  segment: { label: "Segment", icon: Route, color: "#2dd4bf" },
  storyboard: { label: "Storyboard", icon: Layers, color: "#60a5fa" },
  video: { label: "Video", icon: Video, color: "#fb7185" },
  merge: { label: "Merge", icon: GitBranch, color: "#c084fc" },
  note: { label: "Note", icon: Box, color: "#94a3b8" },
};

export const TOOLBAR_KINDS: ToolbarItem[] = [
  { kind: "script", label: "Script", icon: FileText },
  { kind: "scriptboard", label: "Scriptboard", icon: GitBranch },
  { kind: "segment", label: "Segment", icon: Route },
  { kind: "character", label: "Nhân vật", icon: CircleUserRound },
  { kind: "scene", label: "Cảnh", icon: MonitorPlay },
  { kind: "storyboard", label: "Storyboard", icon: Layers },
  { kind: "video", label: "Video", icon: Video },
  { kind: "merge", label: "Merge", icon: GitBranch },
];

export async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

export function toFlowNode(node: ProjectNode): FlowNodeType {
  const output = (typeof node.output === 'object' && node.output !== null ? node.output : {}) as {
    reference?: unknown;
    imageUrl?: unknown;
    mediaId?: unknown;
    mediaIds?: unknown;
    mediaUrls?: unknown;
    posterMediaId?: unknown;
    storyboardGrid?: unknown;
    duration?: unknown;
    durationS?: unknown;
    videoQuality?: unknown;
    videoUrl?: unknown;
  };
  const mediaId =
    typeof output.mediaId === 'string'
      ? output.mediaId
      : typeof node.mediaId === 'string'
        ? node.mediaId
        : typeof node.data?.mediaId === 'string'
          ? node.data.mediaId
          : undefined;
  const posterMediaId =
    typeof output.posterMediaId === 'string'
      ? output.posterMediaId
      : typeof node.posterMediaId === 'string'
        ? node.posterMediaId
        : typeof node.data?.posterMediaId === 'string'
          ? node.data.posterMediaId
          : undefined;
  const mediaIds = Array.isArray(output.mediaIds)
    ? (output.mediaIds.filter((item) => typeof item === 'string') as string[])
    : Array.isArray(node.mediaIds)
      ? node.mediaIds
      : node.data?.mediaIds;
  const mediaUrls = Array.isArray(output.mediaUrls)
    ? (output.mediaUrls.filter((item) => typeof item === 'string') as string[])
    : Array.isArray(node.mediaUrls)
      ? node.mediaUrls
      : node.data?.mediaUrls;
  const primaryMediaId = mediaId || posterMediaId || mediaIds?.[0];
  return {
    id: node.id,
    type: "flowNode",
    position: node.position,
    data: {
      id: node.id,
      kind: node.kind,
      title: node.title,
      status: node.status,
      requestState: node.data?.requestState ?? node.requestState,
      waitingSince: node.data?.waitingSince ?? node.waitingSince,
      requestTimeoutMs: node.data?.requestTimeoutMs ?? node.requestTimeoutMs,
      mediaId: primaryMediaId,
      mediaIds,
      mediaUrls,
      posterMediaId,
      storyboardGrid: typeof output.storyboardGrid === 'string' ? output.storyboardGrid : node.data?.storyboardGrid,
      duration: typeof node.duration === 'number' ? node.duration : typeof node.data?.duration === 'number' ? node.data.duration : undefined,
      durationS: typeof output.durationS === 'number' ? output.durationS : node.data?.durationS,
      videoQuality: typeof node.videoQuality === 'string' ? node.videoQuality as '2k' | '4k' : node.data?.videoQuality,
      prompt: node.data?.prompt ?? node.prompt,
      output: node.data?.output ?? node.output,
      reference:
        node.data?.reference ??
        node.reference ??
        (typeof output.reference === 'string'
          ? output.reference
          : typeof output.imageUrl === 'string'
            ? output.imageUrl
            : undefined),
      referenceName: node.data?.referenceName ?? node.referenceName,
      referenceType: node.data?.referenceType ?? node.referenceType,
      uploadedAt: node.data?.uploadedAt ?? node.uploadedAt,
      data: node.data ?? {
        prompt: node.prompt,
        output: node.output,
        reference: node.reference,
        referenceName: node.referenceName,
        referenceType: node.referenceType,
        uploadedAt: node.uploadedAt,
      },
    },
  };
}
