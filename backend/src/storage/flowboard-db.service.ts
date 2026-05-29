import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { BoardEdge, BoardNode, NodeKind, NodeStatus, Project } from '../board/board.types';

export type GenerationJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'sent';

export interface GenerationJobRecord {
  id: string;
  projectId: string;
  nodeId: string;
  kind: NodeKind;
  provider: 'mock' | 'google-flow';
  prompt: string;
  upstream: Array<{
    id: string;
    kind: NodeKind;
    title: string;
    data: Record<string, any>;
    output?: Record<string, any>;
  }>;
  status: GenerationJobStatus;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, any> | string | null;
  error?: string | null;
}

interface FlowboardDbState {
  version: 1;
  updatedAt: string;
  projects: Project[];
  jobs: GenerationJobRecord[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

@Injectable()
export class FlowboardDbService {
  private readonly filePath = join(process.cwd(), 'data', 'flowboard-db.json');
  private state: FlowboardDbState;
  private readonly nodeWidth = 260;
  private readonly nodeHeight = 168;
  private readonly nodeGap = 48;

  constructor() {
    this.state = this.loadOrCreate();
  }

  getUpdatedAt(): string {
    return this.state.updatedAt;
  }

  getProjects(): Project[] {
    return clone(this.state.projects);
  }

  listProjects() {
    return this.state.projects.map(({ id, name, createdAt, updatedAt, nodes, edges }) => ({
      id, name, createdAt, updatedAt, nodeCount: nodes.length, edgeCount: edges.length,
    }));
  }

  getProject(id: string) {
    return clone(this.state.projects.find((p) => p.id === id) ?? this.state.projects[0]);
  }

  createProject(name = 'Untitled Flow') {
    const project = this.createProjectRecord(name);
    this.write((state) => {
      state.projects.unshift(project);
    });
    return clone(project);
  }

  deleteProject(projectId: string) {
    let deleted = false;
    this.write((state) => {
      const before = state.projects.length;
      state.projects = state.projects.filter((project) => project.id !== projectId);
      deleted = state.projects.length !== before;

      if (state.projects.length === 0) {
        state.projects.unshift(this.createProjectRecord('Untitled Flow'));
      }
    });

    return { ok: deleted, projectId };
  }

  addNode(projectId: string, payload: { kind: NodeKind; title?: string; position?: { x: number; y: number } }) {
    let created: BoardNode | null = null;
    this.write((state) => {
      const project = this.getProjectMutable(state, projectId);
      const basePosition = payload.position || { x: 240, y: 180 };
      const position = this.findFreePosition(project.nodes, basePosition);
      const node: BoardNode = {
        id: randomUUID(),
        kind: payload.kind,
        title: payload.title || this.titleFromKind(payload.kind),
        status: 'idle',
        position,
        data: this.defaultData(payload.kind),
      };
      project.nodes.push(node);
      project.updatedAt = new Date().toISOString();
      created = node;
    });
    return clone(created!);
  }

  updateNode(projectId: string, nodeId: string, patch: Partial<BoardNode>) {
    let updated: BoardNode | null = null;
    this.write((state) => {
      const project = this.getProjectMutable(state, projectId);
      const node = project.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      Object.assign(node, patch, { data: { ...node.data, ...(patch.data || {}) } });
      project.updatedAt = new Date().toISOString();
      updated = node;
    });
    return updated ? clone(updated) : null;
  }

  addEdge(projectId: string, payload: { source: string; target: string }) {
    let created: BoardEdge | null = null;
    this.write((state) => {
      const project = this.getProjectMutable(state, projectId);
      const existed = project.edges.find((e) => e.source === payload.source && e.target === payload.target);
      if (existed) {
        created = existed;
        return;
      }
      const edge: BoardEdge = { id: randomUUID(), source: payload.source, target: payload.target };
      project.edges.push(edge);
      project.updatedAt = new Date().toISOString();
      created = edge;
    });
    return clone(created!);
  }

  deleteNode(projectId: string, nodeId: string) {
    const result = this.write((state) => {
      const project = this.getProjectMutable(state, projectId);
      const before = project.nodes.length;
      project.nodes = project.nodes.filter((n) => n.id !== nodeId);
      project.edges = project.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
      project.updatedAt = new Date().toISOString();
      return { ok: before !== project.nodes.length, nodeId };
    });
    return result;
  }

  deleteEdge(projectId: string, edgeId: string) {
    const result = this.write((state) => {
      const project = this.getProjectMutable(state, projectId);
      const before = project.edges.length;
      project.edges = project.edges.filter((e) => e.id !== edgeId);
      project.updatedAt = new Date().toISOString();
      return { ok: before !== project.edges.length, edgeId };
    });
    return result;
  }

  setNodeStatus(projectId: string, nodeId: string, status: NodeStatus, output?: Record<string, any>) {
    return this.updateNode(projectId, nodeId, { status, output });
  }

  getUpstreamNodes(projectId: string, nodeId: string) {
    const project = this.getProject(projectId);
    const sourceIds = project.edges.filter((e) => e.target === nodeId).map((e) => e.source);
    return project.nodes.filter((n) => sourceIds.includes(n.id));
  }

  recordJob(job: Omit<GenerationJobRecord, 'status' | 'createdAt' | 'updatedAt' | 'result' | 'error'> & Partial<Pick<GenerationJobRecord, 'status' | 'result' | 'error'>> ) {
    const now = new Date().toISOString();
    const record: GenerationJobRecord = {
      ...job,
      status: job.status || 'queued',
      createdAt: now,
      updatedAt: now,
      result: job.result ?? null,
      error: job.error ?? null,
    };
    this.write((state) => {
      state.jobs.unshift(record);
    });
    return clone(record);
  }

  getJob(id: string) {
    return clone(this.state.jobs.find((job) => job.id === id) ?? null);
  }

  updateJob(id: string, patch: Partial<GenerationJobRecord>) {
    let updated: GenerationJobRecord | null = null;
    this.write((state) => {
      const job = state.jobs.find((entry) => entry.id === id);
      if (!job) return;
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      updated = job;
    });
    return updated ? clone(updated) : null;
  }

  private write<T>(mutate: (state: FlowboardDbState) => T): T {
    const result = mutate(this.state);
    this.state.updatedAt = new Date().toISOString();
    this.ensureDir();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
    return result;
  }

  private loadOrCreate(): FlowboardDbState {
    this.ensureDir();
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<FlowboardDbState>;
        if (parsed?.projects?.length) {
          return {
            version: 1,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            projects: parsed.projects,
            jobs: parsed.jobs || [],
          };
        }
      } catch {
        // fall through to seed
      }
    }

    const state: FlowboardDbState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: [this.createSeedProject()],
      jobs: [],
    };
    writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8');
    return state;
  }

  private ensureDir() {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  private getProjectMutable(state: FlowboardDbState, id: string) {
    return state.projects.find((p) => p.id === id) ?? state.projects[0];
  }

  private createSeedProject(): Project {
    const now = new Date().toISOString();
    const character = randomUUID();
    const scene = randomUUID();
    const clothes = randomUUID();
    const accessory = randomUUID();
    const action = randomUUID();
    const style = randomUUID();
    const storyboard = randomUUID();
    const video = randomUUID();
    return {
      id: 'demo-project',
      name: 'chào',
      createdAt: now,
      updatedAt: now,
      nodes: [
        { id: character, kind: 'character', title: 'Nhân vật', status: 'idle', position: { x: 80, y: 80 }, data: { prompt: 'Một nhân vật trẻ trung, phong cách hiện đại' } },
        { id: scene, kind: 'scene', title: 'Cảnh', status: 'idle', position: { x: 80, y: 340 }, data: { prompt: 'Không gian studio sáng tạo, ánh sáng điện ảnh' } },
        { id: clothes, kind: 'clothes', title: 'Quần áo', status: 'idle', position: { x: 80, y: 600 }, data: { prompt: 'Áo hoodie màu xanh' } },
        { id: accessory, kind: 'accessory', title: 'Phụ kiện', status: 'idle', position: { x: 80, y: 860 }, data: { prompt: 'Kính đen, balo nhỏ' } },
        { id: action, kind: 'action', title: 'Hành động', status: 'idle', position: { x: 80, y: 1120 }, data: { prompt: 'Chạy rồi nhảy lên vui vẻ' } },
        { id: style, kind: 'style', title: 'Phong cách', status: 'idle', position: { x: 80, y: 1380 }, data: { prompt: 'Hoạt hình 3D, màu sắc tươi sáng' } },
        { id: storyboard, kind: 'storyboard', title: 'Storyboard', status: 'idle', position: { x: 470, y: 220 }, data: { layout: '2x2', prompt: '' } },
        { id: video, kind: 'video', title: 'Video', status: 'idle', position: { x: 870, y: 210 }, data: { duration: 5, prompt: '' } },
      ],
      edges: [
        { id: randomUUID(), source: character, target: storyboard },
        { id: randomUUID(), source: scene, target: storyboard },
        { id: randomUUID(), source: clothes, target: storyboard },
        { id: randomUUID(), source: accessory, target: storyboard },
        { id: randomUUID(), source: action, target: storyboard },
        { id: randomUUID(), source: style, target: storyboard },
        { id: randomUUID(), source: storyboard, target: video },
      ],
    };
  }

  private createProjectRecord(name = 'Untitled Flow'): Project {
    const now = new Date().toISOString();
    return { id: randomUUID(), name, nodes: [], edges: [], createdAt: now, updatedAt: now };
  }

  private titleFromKind(kind: NodeKind) {
    const map: Record<NodeKind, string> = {
      character: 'Nhân vật', scene: 'Cảnh', clothes: 'Quần áo', accessory: 'Phụ kiện', action: 'Hành động', style: 'Phong cách', image: 'Image', storyboard: 'Storyboard', video: 'Video', note: 'Note',
    };
    return map[kind];
  }

  private defaultData(kind: NodeKind) {
    if (kind === 'storyboard') return { layout: '2x2', prompt: '' };
    if (kind === 'video') return { duration: 8, prompt: '' };
    return { prompt: '', reference: '' };
  }

  private findFreePosition(nodes: BoardNode[], base: { x: number; y: number }) {
    const stepX = this.nodeWidth + this.nodeGap;
    const stepY = this.nodeHeight + this.nodeGap;
    const padding = this.nodeGap / 2;

    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const x = base.x + col * stepX;
        const y = base.y + row * stepY;
        const collides = nodes.some((node) => {
          const leftA = x;
          const topA = y;
          const rightA = x + this.nodeWidth + padding;
          const bottomA = y + this.nodeHeight + padding;

          const leftB = node.position.x;
          const topB = node.position.y;
          const rightB = leftB + this.nodeWidth + padding;
          const bottomB = topB + this.nodeHeight + padding;

          return leftA < rightB && rightA > leftB && topA < bottomB && bottomA > topB;
        });

        if (!collides) return { x, y };
      }
    }

    return {
      x: base.x + 8 * stepX,
      y: base.y + 12 * stepY,
    };
  }
}
