import { Body, Controller, Get, Param, Post, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { MediaService } from './media.service';

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('api/media')
  async upload(@Body() body: { dataUrl?: string; url?: string; filename?: string }) {
    if (body.dataUrl) {
      const stored = await this.media.storeFromDataUrl(body.dataUrl, body.filename || 'upload.bin');
      return stored;
    }
    if (body.url) {
      const stored = await this.media.storeFromUrl(body.url, body.filename || 'upload.bin');
      return stored;
    }
    return { error: 'MISSING_MEDIA' };
  }

  @Get('media/:mediaId')
  get(@Param('mediaId') mediaId: string, @Res({ passthrough: true }) res: Response) {
    const item = this.media.read(mediaId);
    if (!item) {
      res.status(404);
      return { error: 'NOT_FOUND' };
    }
    res.setHeader('Content-Type', item.meta.mime);
    return new StreamableFile(item.buffer);
  }
}
