import { Injectable } from '@nestjs/common';
import { FlowboardDbService } from '../storage/flowboard-db.service';
import { BoardNode, NodeStatus } from './board.types';

@Injectable()
export class BoardService {
  constructor(private readonly db: FlowboardDbService) {}

  listProjects() {
    return this.db.listProjects();
  }

  getProject(id: string) {
    return this.db.getProject(id);
  }

  getUpdatedAt() {
    return this.db.getUpdatedAt();
  }

  createProject(name = 'Untitled Flow') {
    return this.db.createProject(name);
  }

  addNode(projectId: string, payload: { kind: BoardNode['kind']; title?: string; position?: { x: number; y: number } }) {
    return this.db.addNode(projectId, payload);
  }

  updateNode(projectId: string, nodeId: string, patch: Partial<BoardNode>) {
    return this.db.updateNode(projectId, nodeId, patch);
  }

  addEdge(projectId: string, payload: { source: string; target: string }) {
    return this.db.addEdge(projectId, payload);
  }

  deleteNode(projectId: string, nodeId: string) {
    return this.db.deleteNode(projectId, nodeId);
  }

  deleteEdge(projectId: string, edgeId: string) {
    return this.db.deleteEdge(projectId, edgeId);
  }

  setNodeStatus(projectId: string, nodeId: string, status: NodeStatus, output?: Record<string, any>) {
    return this.db.setNodeStatus(projectId, nodeId, status, output);
  }

  getUpstreamNodes(projectId: string, nodeId: string) {
    return this.db.getUpstreamNodes(projectId, nodeId);
  }
}
