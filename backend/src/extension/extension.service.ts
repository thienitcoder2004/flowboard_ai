import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { BoardService } from '../board/board.service';

export interface FlowUserStatus {
  loggedIn: boolean;
  email?: string;
  name?: string;
  avatar?: string;
  source?: string;
  accountId?: string;
  updatedAt?: string;
}

export interface PackageInfo {
  name: string;
  version: string;
}

function readPackageInfo(): PackageInfo {
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

    return {
      name: pkg.name || 'flowboard-v1-backend',
      version: pkg.version || '1.0.0',
    };
  } catch {
    return { name: 'flowboard-v1-backend', version: '1.0.0' };
  }
}

@Injectable()
export class ExtensionService implements OnModuleInit {
  private server: WebSocketServer;
  private clients = new Set<WebSocket>();
  private flowUser: FlowUserStatus = { loggedIn: false, updatedAt: new Date().toISOString() };
  private extensionConnectedAt?: string;
  private backendPackage: PackageInfo = readPackageInfo();
  private extensionPackage?: PackageInfo;

  constructor(private readonly board: BoardService) {}

  onModuleInit() {
    this.server = new WebSocketServer({ port: 9223 });
    this.server.on('connection', (ws) => {
      this.clients.add(ws);
      this.extensionConnectedAt = new Date().toISOString();
      ws.send(JSON.stringify({ type: 'agent_ready', message: 'NestJS agent connected' }));
      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  getStatus() {
    return {
      agent: { connected: true, api: 'http://127.0.0.1:8101', ws: 'ws://127.0.0.1:9223' },
      extension: { connected: this.clients.size > 0, count: this.clients.size, connectedAt: this.extensionConnectedAt },
      googleFlow: this.flowUser,
      backendPackage: this.backendPackage,
      extensionPackage: this.extensionPackage,
      board: { updatedAt: this.board.getUpdatedAt() },
    };
  }

  sendJob(job: any) {
    const payload = JSON.stringify({ type: 'generate_job', job });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
    return { sent: this.clients.size, job };
  }

  private handleMessage(ws: WebSocket, raw: string) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'flow_user_status') {
        this.flowUser = { ...msg.user, updatedAt: new Date().toISOString() };
        if (msg.extensionPackage?.name && msg.extensionPackage?.version) {
          this.extensionPackage = msg.extensionPackage;
        }
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
        return;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }
}
