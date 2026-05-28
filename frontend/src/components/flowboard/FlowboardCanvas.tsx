import React from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ImageIcon, Video } from "lucide-react";
import FlowboardNode from "./FlowboardNode";
import type { FlowNodeType, Kind, MenuState } from "./flowboardTypes";

const nodeTypes = { flowNode: FlowboardNode };

type Props = {
  nodes: FlowNodeType[];
  edges: Edge[];
  onNodesChange: OnNodesChange<FlowNodeType>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: (params: Connection) => void | Promise<void>;
  menu: MenuState | null;
  onPaneContextMenu: (event: MouseEvent | React.MouseEvent<Element, MouseEvent>) => void;
  onClearSelection: () => void;
  onSelectNode: (node: FlowNodeType) => void;
  onSelectEdge: (edge: Edge) => void;
  onAddKind: (kind: Kind, position?: { x: number; y: number }) => void | Promise<void>;
};

export default function FlowboardCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  menu,
  onPaneContextMenu,
  onClearSelection,
  onSelectNode,
  onSelectEdge,
  onAddKind,
}: Props) {
  return (
    <section className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={onClearSelection}
        onNodeClick={(_, node) => onSelectNode(node as FlowNodeType)}
        onEdgeClick={(_, edge) => onSelectEdge(edge)}
        fitView
      >
        <Background color="#263044" gap={24} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => void onAddKind("image", { x: menu.flowX, y: menu.flowY })}>
            <ImageIcon size={16} /> Image
          </button>
          <button onClick={() => void onAddKind("video", { x: menu.flowX, y: menu.flowY })}>
            <Video size={16} /> Video
          </button>
        </div>
      )}
    </section>
  );
}
