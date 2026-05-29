import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
    const effectiveProvider = node.kind === 'merge' ? 'mock' : provider;
    const upstream = this.board.getUpstreamNodes(projectId, nodeId);
    const context = this.buildContext(node, upstream);

    const validationError = this.validateNode(node, context);
    if (validationError) {
      this.board.setNodeStatus(projectId, nodeId, 'failed', { error: validationError });
      return { error: validationError };
    }

    const job = {
      id: randomUUID(), projectId, nodeId, kind: node.kind, provider: effectiveProvider, videoQuality,
      projectName: project.name,
      prompt: this.composePrompt(node, upstream),
      upstream: upstream.map((n) => ({ id: n.id, kind: n.kind, title: n.title, data: n.data, output: n.output })),
      context,
    };
    this.db.recordJob({
      ...this.sanitizeJobForStorage(job),
      status: 'running',
    });
    this.board.setNodeStatus(projectId, nodeId, 'generating');
    if (effectiveProvider === 'google-flow') {
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
      const requiredInputs = [
        ...context.inputs.character,
        ...context.inputs.scene,
        ...context.inputs.image,
      ];
      if (requiredInputs.length < 2) {
        return 'Storyboard requires at least 2 input nodes (character / scene / image)';
      }
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
      script: [],
      scriptboard: [],
      segment: [],
      storyboard: [],
      video: [],
      merge: [],
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

    const cast = inputs.character.map((item) => this.pickPrompt(item)).filter(Boolean);
    const scenes = inputs.scene.map((item) => this.pickPrompt(item)).filter(Boolean);

    return { node, inputs, storyboard, primary, cast, scenes };
  }

  private composePrompt(node: BoardNode, upstream: BoardNode[]) {
    const parts = upstream.map((n) => `${n.title}: ${n.data?.prompt || n.output?.description || ''}`).filter(Boolean);
    parts.push(`${node.title}: ${node.data?.prompt || ''}`);
    const prompt = parts.join('\n');
    if (node.kind === 'note') return prompt;
    return `${prompt}\n\n${this.buildReferenceGuidance(upstream)}`;
  }

  private buildReferenceGuidance(upstream: BoardNode[]) {
    const hasReferenceInput = upstream.some((item) =>
      Boolean(
        item.data?.reference ||
        item.data?.mediaId ||
        item.output?.mediaId ||
        item.output?.mediaUrl ||
        item.output?.posterMediaId ||
        item.output?.reference,
      ),
    );

    const base = [
      'Ràng buộc mặc định: giữ đúng chủ thể gốc theo ảnh tham chiếu (khuôn mặt, hình dạng, màu sắc, chi tiết nhận diện, thiết kế chính).',
      'Chỉ thay đổi tư thế, góc máy, hành động, và bối cảnh nếu prompt yêu cầu.',
      'Nếu prompt không yêu cầu thay đổi, phải giữ nguyên chủ thể như ảnh gốc.',
      'Không trộn lẫn hay thay thế sang chủ thể khác.',
    ];

    if (hasReferenceInput) {
      base.unshift(
        'Ưu tiên bám sát ảnh input rõ, sáng, ít nhiễu; giữ nguyên đặc điểm nhận diện của chủ thể trong ảnh tham chiếu.',
      );
    }

    return base.join(' ');
  }

  private async mockOutput(node: BoardNode, prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    if (node.kind === 'scriptboard') {
      return this.mockScriptboardOutput(node, prompt, context, jobId);
    }
    if (node.kind === 'segment') {
      return this.mockSegmentOutput(node, prompt, context, jobId);
    }
    if (node.kind === 'storyboard') {
      return this.mockStoryboardOutput(prompt, context, jobId);
    }
    if (node.kind === 'video') {
      return this.mockVideoOutput(prompt, context, jobId);
    }
    if (node.kind === 'merge') {
      return this.mockMergeOutput(prompt, context, jobId);
    }
    return this.mockMediaNodeOutput(node, prompt, jobId);
  }

  private async mockScriptboardOutput(node: BoardNode, prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    const scriptNode = context.inputs.script[0];
    const source = scriptNode?.data?.script || scriptNode?.data?.prompt || node.data?.script || node.data?.prompt || prompt;
    const parts = String(source || '')
      .split(/\n{2,}|(?<=\.)\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const sceneCount = Number(node.data?.sceneCount || 3);
    const scenes = Array.from({ length: sceneCount }, (_, index) => {
      const text = parts[index] || parts[0] || `Phân cảnh ${index + 1}`;
      return {
        index: index + 1,
        title: `Scene ${index + 1}`,
        prompt: text,
        duration: 8,
      };
    });
    const stored = await this.media.storeText(JSON.stringify({ prompt, scenes }, null, 2), 'application/json', `${jobId}-scriptboard.json`);
    return {
      description: 'Scriptboard đã breakdown thành 3 phân cảnh.',
      prompt,
      scenes,
      mediaId: stored?.mediaId,
      mediaUrl: stored?.url,
    };
  }

  private async mockSegmentOutput(node: BoardNode, prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    const scriptboard = context.inputs.scriptboard[0]?.output || {};
    const scenes = Array.isArray(scriptboard.scenes) ? scriptboard.scenes : [];
    const segmentIndex = Number(node.data?.segmentIndex || 1);
    const selected = scenes[segmentIndex - 1] || scenes[0] || null;
    const output = {
      index: segmentIndex,
      title: selected?.title || `Scene ${segmentIndex}`,
      prompt: [selected?.prompt, node.data?.prompt].filter(Boolean).join('\n'),
      duration: Number(node.data?.duration || selected?.duration || 8),
    };
    const stored = await this.media.storeText(JSON.stringify(output, null, 2), 'application/json', `${jobId}-segment.json`);
    return {
      description: `Segment ${segmentIndex} đã sẵn sàng.`,
      ...output,
      mediaId: stored?.mediaId,
      mediaUrl: stored?.url,
    };
  }

  private async mockMergeOutput(prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    const videos = context.inputs.video
      .map((item) => item.output)
      .filter(Boolean)
      .map((output, index) => ({
        index: index + 1,
        videoUrl: output?.videoUrl || output?.mediaUrl || output?.posterUrl || '',
        duration: output?.durationS || output?.duration || null,
      }))
      .filter((item) => item.videoUrl);
    const manifest = { prompt, videos, transition: context.node.data?.transition || 'cut' };
    const stored = await this.media.storeText(JSON.stringify(manifest, null, 2), 'application/json', `${jobId}-merge-manifest.json`);

    if (videos.length >= 2) {
      const merged = await this.tryMergeVideos(videos.map((item) => item.videoUrl), jobId);
      if (merged) {
        return {
          description: `Đã ghép ${videos.length} video segment bằng FFmpeg.`,
          prompt,
          videos,
          finalVideoUrl: merged.url,
          mediaId: merged.mediaId,
          mediaUrl: merged.url,
          manifestMediaId: stored?.mediaId,
          manifestUrl: stored?.url,
        };
      }
    }

    return {
      description: videos.length
        ? `Chưa ghép được ${videos.length} video segment. Kiểm tra FFmpeg trong PATH và video input.`
        : 'Merge cần video segment upstream.',
      prompt,
      videos,
      finalVideoUrl: '',
      error: videos.length >= 2 ? 'FFMPEG_MERGE_FAILED' : 'MERGE_REQUIRES_AT_LEAST_2_VIDEOS',
      mediaId: stored?.mediaId,
      mediaUrl: stored?.url,
    };
  }

  private async tryMergeVideos(videoUrls: string[], jobId: string) {
    const tempDir = mkdtempSync(join(tmpdir(), `flowboard-merge-${jobId}-`));
    try {
      const inputPaths: string[] = [];

      for (let index = 0; index < videoUrls.length; index += 1) {
        const localPath = await this.resolveVideoToLocalPath(videoUrls[index], tempDir, index);
        if (!localPath) return null;
        inputPaths.push(localPath);
      }

      const concatFile = join(tempDir, 'inputs.txt');
      writeFileSync(
        concatFile,
        inputPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'),
        'utf8',
      );

      const outputPath = join(tempDir, `${jobId}-final.mp4`);
      await this.execFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath,
      ]);

      if (!existsSync(outputPath)) return null;
      const buffer = readFileSync(outputPath);
      return this.media.storeBuffer(buffer, 'video/mp4', `${jobId}-final.mp4`);
    } catch {
      return null;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async resolveVideoToLocalPath(videoUrl: string, tempDir: string, index: number) {
    const mediaId = this.extractLocalMediaId(videoUrl);
    if (mediaId) {
      const meta = this.media.getMedia(mediaId);
      if (meta?.path && existsSync(meta.path)) return meta.path;
    }

    if (videoUrl.startsWith('data:')) {
      const stored = await this.media.storeFromDataUrl(videoUrl, `merge-input-${index}.mp4`);
      if (stored?.path && existsSync(stored.path)) return stored.path;
    }

    if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) return null;
    const response = await fetch(videoUrl);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const outPath = join(tempDir, `input-${index}.mp4`);
    writeFileSync(outPath, buffer);
    return outPath;
  }

  private extractLocalMediaId(url: string) {
    const match = /\/media\/([^/?#]+)/.exec(url || '');
    return match?.[1] || '';
  }

  private execFfmpeg(args: string[]) {
    return new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private sanitizeJobForStorage(job: any) {
    return this.sanitizeLargeValues(job);
  }

  private sanitizeLargeValues<T>(value: T): T {
    if (typeof value === 'string') {
      if (value.startsWith('data:')) return '[stored-media-data-url-omitted]' as T;
      if (value.length > 2000) return `${value.slice(0, 2000)}…[truncated]` as T;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => this.sanitizeLargeValues(item)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [key, item] of Object.entries(value as Record<string, any>)) {
        out[key] = this.sanitizeLargeValues(item);
      }
      return out as T;
    }
    return value;
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
      cast: context.cast,
      scenes: context.scenes,
      storyboardGrid: '2x2',
      panelPrompts: frames.map((frame) => frame.prompt),
      frames,
      ...(stored || {}),
    };
  }

  private async mockVideoOutput(prompt: string, context: ReturnType<GenerationService['buildContext']>, jobId: string) {
    const storyboardOutput = context.storyboard?.output || {};
    const cast = Array.isArray((storyboardOutput as { cast?: unknown }).cast) ? (storyboardOutput as { cast?: string[] }).cast : context.cast;
    const scenes = Array.isArray((storyboardOutput as { scenes?: unknown }).scenes) ? (storyboardOutput as { scenes?: string[] }).scenes : context.scenes;
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
      description: 'Video mock 8 giây đã sẵn sàng.',
      prompt,
      durationS: Number(context.node.data?.duration || 8),
      cast,
      scenes,
      mediaId: stored?.mediaId,
      mediaUrl: stored?.mediaUrl,
      posterMediaId: stored?.mediaId,
      posterUrl: stored?.mediaUrl,
      videoUrl: stored?.mediaUrl,
      frames: storyboardFrames,
    };
  }

  private buildStoryboardFrames(context: ReturnType<GenerationService['buildContext']>, prompt: string) {
    const cast = context.cast.length ? context.cast : [context.primary.character || 'Nhân vật chính'];
    const scenes = context.scenes.length ? context.scenes : [context.primary.scene || 'bối cảnh'];
    const castText = cast.length === 1 ? cast[0] : cast.map((item, index) => `NV${index + 1}: ${item}`).join('; ');
    const sceneText1 = scenes[0] || 'bối cảnh';
    const sceneText2 = scenes[1] || scenes[0] || 'bối cảnh';
    const clothes = context.primary.clothes ? `, mặc ${context.primary.clothes}` : '';
    const accessory = context.primary.accessory ? `, có ${context.primary.accessory}` : '';
    const style = context.primary.style ? ` theo phong cách ${context.primary.style}` : '';
    const action = context.primary.action || 'đang di chuyển';
    const castInScene = cast.length > 1 ? `${castText}` : castText;

    return [
      { title: 'Frame 1', prompt: `${castInScene} ở ${sceneText1}${clothes}${accessory}${style}. Mở cảnh.` },
      { title: 'Frame 2', prompt: `${castInScene} bắt đầu ${action} trong ${sceneText1}${clothes}${accessory}${style}.` },
      { title: 'Frame 3', prompt: `${castInScene} cao trào ${action} từ ${sceneText1} sang ${sceneText2}${clothes}${accessory}${style}.` },
      { title: 'Frame 4', prompt: `${castInScene} kết thúc cảnh ở ${sceneText2} với cảm xúc vui vẻ${style}.` },
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
