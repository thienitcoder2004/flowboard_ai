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

    if (typeof output.mediaId === 'string') return output;

    const directReference =
      typeof output.reference === 'string'
        ? output.reference
        : typeof output.imageUrl === 'string'
          ? output.imageUrl
          : typeof output.videoUrl === 'string'
            ? output.videoUrl
            : '';

    if (!directReference) return output;

    const stored = directReference.startsWith('data:')
      ? await this.media.storeFromDataUrl(directReference, `${filenameBase}.bin`)
      : await this.media.storeFromUrl(directReference, `${filenameBase}.bin`);

    if (!stored) return output;

    return {
      ...output,
      mediaId: stored.mediaId,
      mediaUrl: stored.url,
      posterMediaId: output.posterMediaId || stored.mediaId,
      posterUrl: output.posterUrl || stored.url,
      videoUrl: output.videoUrl || stored.url,
      reference: stored.url,
    };
  }
}
