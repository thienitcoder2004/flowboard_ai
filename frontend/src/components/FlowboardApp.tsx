import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Connection,
  type Edge,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import FlowboardCanvas from "./flowboard/FlowboardCanvas";
import FlowboardInspector from "./flowboard/FlowboardInspector";
import FlowboardSidebar from "./flowboard/FlowboardSidebar";
import FlowboardTopBar from "./flowboard/FlowboardTopBar";
import FlowboardToolbar from "./flowboard/FlowboardToolbar";
import {
  API,
  TOOLBAR_KINDS,
  readJson,
  toFlowNode,
} from "./flowboard/flowboardHelpers";
import "../App.css";
import type {
  AgentStatus,
  FlowNodeType,
  FlowboardNodeActionDetail,
  Kind,
  MenuState,
  ProjectEdge,
  ProjectNode,
  ProjectRecord,
  ProjectSummary,
} from "./flowboard/flowboardTypes";

export default function FlowboardApp() {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<FlowNodeType | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draftPrompt, setDraftPrompt] = useState("");
  const [uploadingNodeId, setUploadingNodeId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const boardUpdatedAtRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const pendingGoogleFlowRef = useRef<Record<string, { startedAt: string; timeoutMs: number }>>({});

  const selectNode = useCallback((node: FlowNodeType | null) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    setDraftPrompt((node?.data.prompt ?? node?.data.data?.prompt ?? "") as string);
  }, []);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNode?.id ?? null;
  }, [selectedNode?.id]);

  const clearSelection = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setDraftPrompt("");
  }, []);

  const patchNodeData = useCallback(
    async (nodeId: string, data: Record<string, unknown>) => {
      if (!project) return null;

      const updated = await readJson<ProjectNode>(
        await fetch(`${API}/api/projects/${project.id}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        }),
      );

      const nextNode = toFlowNode(updated);
      setNodes((currentNodes) =>
        currentNodes.map((node) => (node.id === nodeId ? nextNode : node)),
      );

      if (selectedNode?.id === nodeId) {
        setSelectedNode(nextNode);
      }

      return nextNode;
    },
    [project, selectedNode?.id, setNodes],
  );

  const handleUploadChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const nodeId = uploadingNodeId;
      event.target.value = "";
      setUploadingNodeId(null);

      if (!file || !nodeId) return;

      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!dataUrl) return;

        const uploaded = await fetch(`${API}/api/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl, filename: file.name }),
        }).then((response) => response.json() as Promise<{ mediaId?: string; url?: string; mime?: string }>);

        await patchNodeData(nodeId, {
          mediaId: uploaded.mediaId,
          reference: uploaded.url,
          referenceName: file.name,
          referenceType: uploaded.mime || file.type,
          uploadedAt: new Date().toISOString(),
        });
      };

      reader.readAsDataURL(file);
    },
    [patchNodeData, uploadingNodeId],
  );

  const load = useCallback(
    async (projectId: string) => {
      const [projectsResponse, projectResponse] = await Promise.all([
        fetch(`${API}/api/projects`),
        fetch(`${API}/api/projects/${projectId}`),
      ]);

      const [nextProjects, nextProject] = await Promise.all([
        readJson<ProjectSummary[]>(projectsResponse),
        readJson<ProjectRecord>(projectResponse),
      ]);

      setProjects(nextProjects);
      setProject(nextProject);
      activeProjectIdRef.current = nextProject.id;
      boardUpdatedAtRef.current = nextProject.updatedAt ?? null;

      const nextNodes = (nextProject.nodes || []).map(toFlowNode);
      for (const node of nextNodes) {
        const pending = pendingGoogleFlowRef.current[node.id];
        if (pending && node.data.status === "generating") {
          node.data.requestState = "waiting";
          node.data.waitingSince = pending.startedAt;
          node.data.requestTimeoutMs = pending.timeoutMs;
        } else {
          delete pendingGoogleFlowRef.current[node.id];
        }
      }
      const nextEdges = (nextProject.edges || []).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: true,
        className: "edge-line",
      }));

      setNodes(nextNodes);
      setEdges(nextEdges);

      const activeNodeId = selectedNodeIdRef.current;
      if (activeNodeId) {
        const nextSelected = nextNodes.find((node) => node.id === activeNodeId) || null;
        setSelectedNode(nextSelected);
        setDraftPrompt((nextSelected?.data.prompt ?? nextSelected?.data.data?.prompt ?? "") as string);
      }
    },
    [setEdges, setNodes],
  );

  const refreshStatus = useCallback(async () => {
    const nextStatus = await fetch(`${API}/api/agent/status`)
      .then((response) => response.json() as Promise<AgentStatus>)
      .catch(() => null);

    setStatus(nextStatus);
    const boardUpdatedAt = nextStatus?.board?.updatedAt ?? null;
    if (boardUpdatedAt && boardUpdatedAt !== boardUpdatedAtRef.current) {
      boardUpdatedAtRef.current = boardUpdatedAt;
      const projectId = activeProjectIdRef.current;
      if (projectId) {
        void load(projectId);
      }
    }
  }, [load]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load("demo-project");
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refreshStatus();
    }, 0);

    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 1300);

    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [refreshStatus]);

  const addKind = useCallback(
    async (kind: Kind, position?: { x: number; y: number }) => {
      if (!project) return;

      const res = await readJson<ProjectNode>(
        await fetch(`${API}/api/projects/${project.id}/nodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            position: position || { x: 260, y: 180 },
          }),
        }),
      );

      const newNode = toFlowNode(res);
      setNodes((currentNodes) => currentNodes.concat(newNode));
      selectNode(newNode);
      setMenu(null);
    },
    [project, selectNode, setNodes],
  );

  const createProject = useCallback(async () => {
    const name = window.prompt("Tên project mới:", "Untitled Flow") || "Untitled Flow";

    const nextProject = await readJson<ProjectRecord>(
      await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );

    await load(nextProject.id);
  }, [load]);

  const savePrompt = useCallback(
    async (targetNodeId = selectedNode?.id, prompt = draftPrompt) => {
      if (!project || !targetNodeId) return null;

      const saved = await readJson<ProjectNode>(
        await fetch(`${API}/api/projects/${project.id}/nodes/${targetNodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { prompt } }),
        }),
      );

      const nextNode = toFlowNode(saved);
      setNodes((currentNodes) =>
        currentNodes.map((node) => (node.id === nextNode.id ? nextNode : node)),
      );
      setProject((currentProject) =>
        currentProject
          ? {
              ...currentProject,
              nodes: currentProject.nodes.map((node) =>
                node.id === nextNode.id ? saved : node,
              ),
            }
          : currentProject,
      );

      if (selectedNode?.id === nextNode.id) {
        setSelectedNode(nextNode);
      }

      return nextNode;
    },
    [draftPrompt, project, selectedNode?.id, setNodes],
  );

  const generate = useCallback(
    async (
      provider: "mock" | "google-flow" = "mock",
      nodeId = selectedNode?.id,
      options: { saveDraft?: boolean } = {},
    ) => {
      if (!project || !nodeId) return;

      if (options.saveDraft) {
        await savePrompt(nodeId);
      }

      const startedAt = new Date().toISOString();
      const timeoutMs = provider === "google-flow" ? 60000 : 0;

      setNodes((currentNodes) =>
        currentNodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: "generating",
                  ...(provider === "google-flow"
                    ? { requestState: "waiting", waitingSince: startedAt, requestTimeoutMs: timeoutMs }
                    : {}),
                },
              }
            : node,
        ),
      );

      if (provider === "google-flow") {
        pendingGoogleFlowRef.current[nodeId] = { startedAt, timeoutMs };
      }

      await fetch(`${API}/api/generation/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          nodeId,
          provider,
        }),
      });

      await load(project.id);
    },
    [load, project, savePrompt, selectedNode?.id, setNodes],
  );

  const deleteSelection = useCallback(async () => {
    if (!project) return;

    if (selectedEdge) {
      await fetch(`${API}/api/projects/${project.id}/edges/${selectedEdge.id}`, {
        method: "DELETE",
      });

      setEdges((currentEdges) =>
        currentEdges.filter((edge) => edge.id !== selectedEdge.id),
      );
      setSelectedEdge(null);
      return;
    }

    if (selectedNode) {
      await fetch(`${API}/api/projects/${project.id}/nodes/${selectedNode.id}`, {
        method: "DELETE",
      });

      setNodes((currentNodes) =>
        currentNodes.filter((node) => node.id !== selectedNode.id),
      );
      setEdges((currentEdges) =>
        currentEdges.filter(
          (edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id,
        ),
      );
      setProject((currentProject) =>
        currentProject
          ? {
              ...currentProject,
              nodes: currentProject.nodes.filter((node) => node.id !== selectedNode.id),
              edges: currentProject.edges.filter(
                (edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id,
              ),
            }
          : currentProject,
      );
      clearSelection();
    }
  }, [clearSelection, project, selectedEdge, selectedNode, setEdges, setNodes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        (selectedNode || selectedEdge)
      ) {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;

        event.preventDefault();
        void deleteSelection();
      }
    };

    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<FlowboardNodeActionDetail>).detail;
      if (!detail) return;

      const node = nodes.find((entry) => entry.id === detail.nodeId) || null;
      const saveDraft = selectedNode?.id === detail.nodeId;

      if (node) {
        setSelectedNode(node);
        setDraftPrompt((node.data.prompt ?? node.data.data?.prompt ?? "") as string);
        setSelectedEdge(null);
      }

      if (detail.type === "generate") {
        void generate("mock", detail.nodeId, { saveDraft });
      }

      if (detail.type === "upload") {
        if (node) {
          setSelectedNode(node);
          setSelectedEdge(null);
          setDraftPrompt((node.data.prompt ?? node.data.data?.prompt ?? "") as string);
        }
        setUploadingNodeId(detail.nodeId);
        uploadInputRef.current?.click();
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("flowboard-node-action", onAction);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("flowboard-node-action", onAction);
    };
  }, [deleteSelection, generate, nodes, selectedEdge, selectedNode]);

  const onConnect = useCallback(
    async (params: Connection) => {
      if (!project || !params.source || !params.target) return;

      const res = await readJson<ProjectEdge>(
        await fetch(`${API}/api/projects/${project.id}/edges`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: params.source, target: params.target }),
        }),
      );

      setEdges((currentEdges) =>
        currentEdges.concat({
          id: res.id,
          source: params.source,
          target: params.target,
          animated: true,
          className: "edge-line",
        }),
      );
    },
    [project, setEdges],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent<Element, MouseEvent>) => {
      event.preventDefault();

      const target = "currentTarget" in event ? (event.currentTarget as Element) : null;
      if (!target) return;

      const bounds = target.getBoundingClientRect();

      setMenu({
        x: event.clientX,
        y: event.clientY,
        flowX: event.clientX - bounds.left - 160,
        flowY: event.clientY - bounds.top - 70,
      });
    },
    [],
  );

  return (
    <ReactFlowProvider>
      <div className="app-shell" onClick={() => menu && setMenu(null)}>
        <FlowboardSidebar
          projects={projects}
          activeProjectId={project?.id}
          onCreateProject={createProject}
          onSelectProject={(projectId) => void load(projectId)}
        />

        <main className="workspace">
          <FlowboardTopBar projectName={project?.name} status={status} />

          <FlowboardToolbar items={TOOLBAR_KINDS} onAddKind={(kind) => void addKind(kind)} />

          <FlowboardCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            menu={menu}
            onPaneContextMenu={onPaneContextMenu}
            onClearSelection={clearSelection}
            onSelectNode={selectNode}
            onSelectEdge={(edge) => {
              setSelectedEdge(edge);
              setSelectedNode(null);
              setDraftPrompt("");
            }}
            onAddKind={addKind}
          />

          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleUploadChange}
          />
        </main>

        <FlowboardInspector
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          draftPrompt={draftPrompt}
          onDraftPromptChange={setDraftPrompt}
          onSavePrompt={savePrompt}
          onGenerateGoogleFlow={(nodeId) =>
            generate("google-flow", nodeId, { saveDraft: true })
          }
          onDeleteSelection={deleteSelection}
        />
      </div>
    </ReactFlowProvider>
  );
}
