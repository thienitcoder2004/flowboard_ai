import { Body, Controller, Get, Post } from '@nestjs/common';
import { BoardService } from '../board/board.service';
import { FlowboardDbService } from '../storage/flowboard-db.service';
import { MediaService } from '../media/media.service';
import { ExtensionService } from './extension.service';

@Controller('api/agent')
export class ExtensionController {
  constructor(private readonly extension: ExtensionService) {}

  @Get('status')
  status() { return this.extension.getStatus(); }

  @Post('extension/job')
  send(@Body() body: any) { return this.extension.sendJob(body); }
}

@Controller('api/ext')
export class ExtensionCallbackController {
  constructor(
    private readonly board: BoardService,
    private readonly db: FlowboardDbService,
    private readonly media: MediaService,
  ) {}

  @Post('callback')
  async callback(@Body() body: { id?: string; status?: number; data?: any; error?: string }) {
    if (!body?.id) return { error: 'MISSING_JOB_ID' };

    const job = this.db.getJob(body.id);
    if (!job) return { error: 'JOB_NOT_FOUND' };

    const isOk = typeof body.status === 'number' ? body.status < 400 : !body.error;
    const nextStatus = isOk ? 'done' : 'failed';
    const output = await this.normalizeOutput(body.data ?? null, job?.kind || 'media');

    this.db.updateJob(body.id, {
      status: nextStatus,
      result: output,
      error: body.error || null,
    });

    this.board.setNodeStatus(job.projectId, job.nodeId, nextStatus === 'done' ? 'done' : 'failed', output || undefined);

    return { ok: true, jobId: body.id, nodeId: job.nodeId, status: nextStatus };
  }

  private async normalizeOutput(output: any, filenameBase: string) {
    if (!output || typeof output !== 'object') return output;

    const mediaIds = Array.isArray(output.mediaIds)
      ? output.mediaIds.filter((item: unknown) => typeof item === 'string' && item)
      : [];
    const mediaUrls = Array.isArray(output.mediaUrls)
      ? output.mediaUrls.filter((item: unknown) => typeof item === 'string' && item)
      : [];

    const directReference = this.pickSafeReference(
      typeof output.reference === 'string'
        ? output.reference
        : typeof output.imageUrl === 'string'
          ? output.imageUrl
          : typeof output.videoUrl === 'string'
            ? output.videoUrl
            : '',
    );

    const previewReference =
      directReference ||
      this.pickSafeReference(typeof output.mediaUrl === 'string' ? output.mediaUrl : '') ||
      this.pickSafeReference(typeof output.posterUrl === 'string' ? output.posterUrl : '') ||
      this.pickSafeReference(typeof output.mediaUrls?.[0] === 'string' ? output.mediaUrls[0] : '');

    if (mediaUrls.length > 0 && !output.mediaUrl && !output.videoUrl && !output.posterUrl) {
      const storedUrls: string[] = [];
      for (let i = 0; i < mediaUrls.length; i += 1) {
        const src = mediaUrls[i];
        const stored = src.startsWith('data:')
          ? await this.media.storeFromDataUrl(src, `${filenameBase}-${i}.bin`)
          : await this.media.storeFromUrl(src, `${filenameBase}-${i}.bin`);
        if (stored?.url) storedUrls.push(stored.url);
      }
      if (storedUrls.length > 0) {
        return {
          ...output,
          mediaIds: mediaIds.length ? mediaIds : output.mediaIds,
          mediaUrls: storedUrls,
          mediaId: output.mediaId || undefined,
          mediaUrl: storedUrls[0],
          reference: output.reference || storedUrls[0],
        };
      }
    }

    if (typeof output.mediaId === 'string' && !previewReference) {
      return {
        ...output,
        mediaIds: mediaIds.length ? mediaIds : output.mediaIds,
        mediaUrls: mediaUrls.length ? mediaUrls : output.mediaUrls,
      };
    }

    if (typeof output.mediaId === 'string' && previewReference) {
      const stored = previewReference.startsWith('data:')
        ? await this.media.storeFromDataUrl(previewReference, `${filenameBase}.bin`)
        : await this.media.storeFromUrl(previewReference, `${filenameBase}.bin`);

      if (stored) {
        const safeVideoUrl = typeof output.videoUrl === 'string' && !output.videoUrl.startsWith('data:') ? output.videoUrl : stored.url;
        const safeReference = typeof output.reference === 'string' && !output.reference.startsWith('data:') ? output.reference : stored.url;
        return {
          ...output,
          mediaIds: mediaIds.length ? mediaIds : output.mediaIds,
          mediaUrls: mediaUrls.length ? mediaUrls : output.mediaUrls,
          mediaId: stored.mediaId,
          mediaUrl: stored.url,
          posterMediaId: output.posterMediaId || stored.mediaId,
          posterUrl: output.posterUrl || stored.url,
          videoUrl: safeVideoUrl,
          reference: safeReference,
        };
      }
      return output;
    }

    if (!directReference) return output;

    const stored = directReference.startsWith('data:')
      ? await this.media.storeFromDataUrl(directReference, `${filenameBase}.bin`)
      : await this.media.storeFromUrl(directReference, `${filenameBase}.bin`);

    if (!stored) return output;

    const safeVideoUrl = typeof output.videoUrl === 'string' && !output.videoUrl.startsWith('data:') ? output.videoUrl : stored.url;

    return {
      ...output,
      mediaIds: mediaIds.length ? mediaIds : output.mediaIds,
      mediaUrls: mediaUrls.length ? mediaUrls : output.mediaUrls,
      mediaId: stored.mediaId,
      mediaUrl: stored.url,
      posterMediaId: output.posterMediaId || stored.mediaId,
      posterUrl: output.posterUrl || stored.url,
      videoUrl: safeVideoUrl,
      reference: stored.url,
    };
  }

  private pickSafeReference(value: string) {
    if (!value) return '';
    if (/^[a-zA-Z]:[\\/]/.test(value) || /^file:\/\//i.test(value)) return '';
    return value;
  }
}
