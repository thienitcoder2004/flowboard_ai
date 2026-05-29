export type NodeKind = 'character' | 'scene' | 'clothes' | 'accessory' | 'action' | 'style' | 'image' | 'script' | 'scriptboard' | 'segment' | 'storyboard' | 'video' | 'merge' | 'note';
export type NodeStatus = 'idle' | 'queued' | 'generating' | 'done' | 'failed';

export interface BoardNode {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  position: { x: number; y: number };
  data: Record<string, any>;
  output?: Record<string, any>;
}

export interface BoardEdge {
  id: string;
  source: string;
  target: string;
}

export interface Project {
  id: string;
  name: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  createdAt: string;
  updatedAt: string;
}
