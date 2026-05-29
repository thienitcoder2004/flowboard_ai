import type { Edge, Node } from "@xyflow/react";

export type Kind =
  | "character"
  | "scene"
  | "clothes"
  | "accessory"
  | "action"
  | "style"
  | "image"
  | "script"
  | "scriptboard"
  | "segment"
  | "storyboard"
  | "video"
  | "merge"
  | "note";

export type ToolbarKind = Exclude<Kind, "image" | "note">;

export type BoardNodeData = {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  requestState?: "waiting" | "timeout";
  waitingSince?: string;
  requestTimeoutMs?: number;
  mediaId?: string;
  mediaIds?: string[];
  mediaUrls?: string[];
  posterMediaId?: string;
  storyboardGrid?: string;
  duration?: number;
  durationS?: number;
  videoQuality?: "2k" | "4k";
  videoUrl?: string;
  prompt?: string;
  output?: unknown;
  reference?: string;
  referenceName?: string;
  referenceType?: string;
  uploadedAt?: string;
  data?: {
    prompt?: string;
    output?: unknown;
    requestState?: "waiting" | "timeout";
    waitingSince?: string;
    requestTimeoutMs?: number;
    mediaId?: string;
    mediaIds?: string[];
    mediaUrls?: string[];
    posterMediaId?: string;
    storyboardGrid?: string;
    duration?: number;
    durationS?: number;
    videoQuality?: "2k" | "4k";
    videoUrl?: string;
    reference?: string;
    referenceName?: string;
    referenceType?: string;
    uploadedAt?: string;
    [key: string]: unknown;
  };
};

export type FlowNodeType = Node<BoardNodeData, "flowNode">;

export type ProjectSummary = {
  id: string;
  name: string;
  nodeCount: number;
};

export type ProjectNode = {
  id: string;
  position: { x: number; y: number };
  kind: Kind;
  title: string;
  status: string;
  requestState?: "waiting" | "timeout";
  waitingSince?: string;
  requestTimeoutMs?: number;
  mediaId?: string;
  mediaIds?: string[];
  mediaUrls?: string[];
  posterMediaId?: string;
  storyboardGrid?: string;
  duration?: number;
  durationS?: number;
  videoQuality?: "2k" | "4k";
  videoUrl?: string;
  prompt?: string;
  output?: unknown;
  reference?: string;
  referenceName?: string;
  referenceType?: string;
  uploadedAt?: string;
  data?: {
    prompt?: string;
    output?: unknown;
    requestState?: "waiting" | "timeout";
    waitingSince?: string;
    requestTimeoutMs?: number;
    mediaId?: string;
    mediaIds?: string[];
    mediaUrls?: string[];
    posterMediaId?: string;
    storyboardGrid?: string;
    duration?: number;
    durationS?: number;
    videoQuality?: "2k" | "4k";
    videoUrl?: string;
    reference?: string;
    referenceName?: string;
    referenceType?: string;
    uploadedAt?: string;
    [key: string]: unknown;
  };
};

export type ProjectEdge = {
  id: string;
  source: string;
  target: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  updatedAt?: string;
  nodes: ProjectNode[];
  edges: ProjectEdge[];
};

export type AgentStatus = {
  agent?: { connected?: boolean };
  extension?: { connected?: boolean };
  board?: { updatedAt?: string };
  googleFlow?: {
    loggedIn?: boolean;
    label?: string;
    email?: string;
    name?: string;
    source?: string;
    paygateTier?: string;
    credits?: number | null;
  };
  backendPackage?: { name: string; version: string };
  extensionPackage?: { name: string; version: string };
};

export type MenuState = {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
};

export type FlowboardNodeActionDetail = {
  type: "select" | "generate" | "upload" | "preview-storyboard";
  nodeId: string;
};

export type FlowboardSelection = {
  node: FlowNodeType | null;
  edge: Edge | null;
};
