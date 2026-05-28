import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BoardService } from '../board/board.service';
import { BoardNode, NodeKind } from '../board/board.types';
import { ExtensionService } from '../extension/extension.service';
import { MediaService } from '../media/media.service';
import { FlowboardDbService } from '../storage/flowboard-db.service';

@Injectable()
export class GenerationService {
  constructor(
    private readonly board: BoardService,
    private readonly extension: ExtensionService,
    private readonly media: MediaService,
    private readonly db: FlowboardDbService,
  ) {}

  async generate(projectId: string, nodeId: string, provider: 'mock' | 'google-flow' = 'mock', videoQuality?: '2k' | '4k') {
    const project = this.board.getProject(projectId);
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) return { error: 'Node not found' };
    const upstream = this.board.getUpstreamNodes(projectId, nodeId);
    const context = this.buildContext(node, upstream);

    const validationError = this.validateNode(node, context);
    if (validationError) {
      this.board.setNodeStatus(projectId, nodeId, 'failed', { error: validationError });
      return { error: validationError };
    }

    const job = {
      id: randomUUID(), projectId, nodeId, kind: node.kind, provider, videoQuality,
      projectName: project.name,
      prompt: this.composePrompt(node, upstream),
      upstream: upstream.map((n) => ({ id: n.id, kind: n.kind, title: n.title, data: n.data, output: n.output })),
      context,
    };
    this.db.recordJob({
      ...job,
      status: 'running',
    });
    this.board.setNodeStatus(projectId, nodeId, 'generating');
    if (provider === 'google-flow') {
      const res = this.extension.sendJob(job);
      this.db.updateJob(job.id, { status: 'sent' });
      return { mode: 'extension', job, extension: res };
    }
    await new Promise((r) => setTimeout(r, 900));
    const output = await this.mockOutput(node, job.prompt, context, job.id);
    this.board.setNodeStatus(projectId, nodeId, 'done', output);
    this.db.updateJob(job.id, { status: 'done', result: output });
    return { mode: 'mock', job, output };
  }

  private validateNode(node: BoardNode, context: ReturnType<GenerationService['buildContext']>) {
    if (node.kind === 'storyboard') {
      const missing = ['character', 'scene'].filter((kind) => !context.inputs[kind as keyof typeof context.inputs]?.length);
      if (missing.length) return `Missing required inputs: ${missing.join(', ')}`;
    }
    if (node.kind === 'video') {
      const storyboard = context.storyboard;
      const hasFrames = !!storyboard?.output?.frames?.length;
      const hasStoryboardMedia = !!(
        storyboard?.output?.mediaUrls?.length ||
        storyboard?.output?.mediaIds?.length ||
        storyboard?.output?.mediaId ||
        storyboard?.output?.posterMediaId ||
        storyboard?.output?.mediaUrl ||
        storyboard?.output?.posterUrl ||
        storyboard?.output?.reference
      );
      if (!hasFrames && !hasStoryboardMedia) return 'Video requires storyboard output';
    }
    return null;
  }

  private buildContext(node: BoardNode, upstream: BoardNode[]) {
    const inputs: Record<string, BoardNode[]> = {
      character: [],
      scene: [],
      clothes: [],
      accessory: [],
      action: [],
      style: [],
      storyboard: [],
      video: [],
      image: [],
      note: [],
    };

    for (const item of upstream) {
      inputs[item.kind].push(item);
    }

    const storyboard = inputs.storyboard[0] ?? null;
    const primary = {
      character: this.pickPrompt(inputs.character[0]),
      scene: this.pickPrompt(inputs.scene[0]),
      clothes: this.pickPrompt(inputs.clothes[0]),
      accessory: this.pickPrompt(inputs.accessory[0]),
      action: this.pickPrompt(inputs.action[0]),
      style: this.pickPrompt(inputs.style[0]),
    };

    return { node, inputs, storyboard, primary };
  }

  private composePrompt(node: BoardNode, upstream: BoardNode[]) {
    const parts = upstream.map((n) => `${n.title}: ${n.data?.prompt || n.output?.description || ''}`).filter(Boolean);
    parts.push(`${node.title}: ${node.data?.prompt || ''}`);
    return parts.join('\n');
  }

  private async mockOutput(node: BoardNode, prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    if (node.kind === 'storyboard') {
      return this.mockStoryboardOutput(prompt, context, jobId);
    }
    if (node.kind === 'video') {
      return this.mockVideoOutput(prompt, context, jobId);
    }
    return this.mockMediaNodeOutput(node, prompt, jobId);
  }

  private async svgToMedia(svg: string, filename: string) {
    const stored = await this.media.storeText(svg, 'image/svg+xml', filename);
    return stored ? { mediaId: stored.mediaId, mediaUrl: stored.url, mediaType: stored.mime } : null;
  }

  private async mockMediaNodeOutput(node: BoardNode, prompt: string, jobId: string) {
    const title = node.title || node.kind;
    const svg = this.buildPreviewSvg(title, prompt, node.kind);
    const stored = await this.svgToMedia(svg, `${jobId}-${node.kind}.svg`);
    return {
      description: `${node.kind} mock output`,
      prompt,
      ...(stored || {}),
    };
  }

  private async mockStoryboardOutput(prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    const frames = this.buildStoryboardFrames(context, prompt);
    const svg = this.buildStoryboardSvg(context, prompt, frames);
    const stored = await this.svgToMedia(svg, `${jobId}-storyboard.svg`);
    return {
      description: 'Storyboard 4 khung đã được tạo từ các node đầu vào.',
      prompt,
      inputs: context.primary,
      storyboardGrid: '2x2',
      panelPrompts: frames.map((frame) => frame.prompt),
      frames,
      ...(stored || {}),
    };
  }

  private async mockVideoOutput(prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    const storyboardOutput = context.storyboard?.output || {};
    const storyboardFrames = Array.isArray(storyboardOutput.frames) && storyboardOutput.frames.length
      ? storyboardOutput.frames
      : Array.isArray(storyboardOutput.mediaUrls) && storyboardOutput.mediaUrls.length
        ? storyboardOutput.mediaUrls.slice(0, 4).map((src: string, index: number) => ({
            title: `Shot ${index + 1}`,
            prompt: src,
          }))
        : Array.isArray(storyboardOutput.mediaIds) && storyboardOutput.mediaIds.length
          ? storyboardOutput.mediaIds.slice(0, 4).map((id: string, index: number) => ({
              title: `Shot ${index + 1}`,
              prompt: id,
            }))
          : [];
    const svg = this.buildVideoPosterSvg(context, prompt);
    const stored = await this.svgToMedia(svg, `${jobId}-video-poster.svg`);
    return {
      description: 'Video mock 5 giây đã sẵn sàng.',
      prompt,
      durationS: Number(context.node.data?.duration || 5),
      mediaId: stored?.mediaId,
      mediaUrl: stored?.mediaUrl,
      posterMediaId: stored?.mediaId,
      posterUrl: stored?.mediaUrl,
      videoUrl: stored?.mediaUrl,
      frames: storyboardFrames,
    };
  }

  private buildStoryboardFrames(context: ReturnType<GenerationService['buildContext']>, prompt: string) {
    const subject = context.primary.character || 'Nhân vật chính';
    const scene = context.primary.scene || 'bối cảnh';
    const clothes = context.primary.clothes ? `, mặc ${context.primary.clothes}` : '';
    const accessory = context.primary.accessory ? `, có ${context.primary.accessory}` : '';
    const style = context.primary.style ? ` theo phong cách ${context.primary.style}` : '';
    const action = context.primary.action || 'đang di chuyển';

    return [
      { title: 'Frame 1', prompt: `${subject} ở ${scene}${clothes}${accessory}${style}. Mở cảnh.` },
      { title: 'Frame 2', prompt: `${subject} bắt đầu ${action}${clothes}${accessory}${style}.` },
      { title: 'Frame 3', prompt: `${subject} cao trào ${action} trong ${scene}${clothes}${accessory}${style}.` },
      { title: 'Frame 4', prompt: `${subject} kết thúc cảnh với cảm xúc vui vẻ${style}.` },
    ].map((frame, index) => ({
      ...frame,
      index: index + 1,
      prompt: `${prompt}\n${frame.prompt}`,
    }));
  }

  private pickPrompt(node?: BoardNode | null) {
    return node?.data?.prompt || node?.output?.description || '';
  }

  private buildPreviewSvg(title: string, prompt: string, kind: string) {
    const safeTitle = this.escapeXml(title || 'Preview');
    const safePrompt = this.escapeXml((prompt || '').slice(0, 120));
    const safeKind = this.escapeXml(kind);
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#1d4ed8"/>
            <stop offset="100%" stop-color="#7c3aed"/>
          </linearGradient>
        </defs>
        <rect width="720" height="420" rx="28" fill="url(#g)"/>
        <rect x="24" y="24" width="672" height="372" rx="24" fill="rgba(15,23,42,0.72)"/>
        <text x="48" y="96" fill="#fff" font-family="Inter,Arial,sans-serif" font-size="40" font-weight="700">${safeTitle}</text>
        <text x="48" y="156" fill="#cbd5e1" font-family="Inter,Arial,sans-serif" font-size="22">${safeKind} preview</text>
        <text x="48" y="228" fill="#e2e8f0" font-family="Inter,Arial,sans-serif" font-size="20">${safePrompt || 'Preview image'}</text>
      </svg>
    `;
  }

  private buildStoryboardSvg(context: ReturnType<GenerationService['buildContext']>, prompt: string, frames: Array<{ title: string; prompt: string }>) {
    const title = this.escapeXml(context.node.title || 'Storyboard');
    const lines = frames.slice(0, 4).map((frame, idx) => `
      <g transform="translate(${idx % 2 === 0 ? 40 : 370},${idx < 2 ? 40 : 220})">
        <rect width="310" height="140" rx="16" fill="#0f172a" stroke="#334155"/>
        <text x="16" y="28" fill="#fff" font-size="20" font-family="Inter,Arial,sans-serif" font-weight="700">${this.escapeXml(frame.title)}</text>
        <text x="16" y="56" fill="#cbd5e1" font-size="15" font-family="Inter,Arial,sans-serif">${this.escapeXml(frame.prompt.slice(0, 70))}</text>
      </g>`).join('');
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
        <rect width="720" height="420" rx="28" fill="#111827"/>
        <text x="40" y="26" fill="#fff" font-size="24" font-family="Inter,Arial,sans-serif" font-weight="700">${title}</text>
        <text x="40" y="48" fill="#94a3b8" font-size="14" font-family="Inter,Arial,sans-serif">Storyboard • ${this.escapeXml((prompt || '').slice(0, 70))}</text>
        ${lines}
      </svg>
    `;
  }

  private buildVideoPosterSvg(context: ReturnType<GenerationService['buildContext']>, prompt: string) {
    const title = this.escapeXml(context.node.title || 'Video');
    const safePrompt = this.escapeXml((prompt || '').slice(0, 120));
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#dc2626"/>
            <stop offset="100%" stop-color="#0f172a"/>
          </linearGradient>
        </defs>
        <rect width="720" height="420" rx="28" fill="url(#g)"/>
        <circle cx="360" cy="210" r="52" fill="rgba(255,255,255,0.15)"/>
        <polygon points="346,186 346,234 390,210" fill="#fff"/>
        <text x="40" y="70" fill="#fff" font-size="40" font-family="Inter,Arial,sans-serif" font-weight="700">${title}</text>
        <text x="40" y="116" fill="#e2e8f0" font-size="18" font-family="Inter,Arial,sans-serif">${safePrompt || 'Video preview'}</text>
      </svg>
    `;
  }

  private escapeXml(value: string) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
