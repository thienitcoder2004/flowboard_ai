import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export type StoredMedia = {
  mediaId: string;
  mime: string;
  filename: string;
  size: number;
  createdAt: string;
  path: string;
};

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function decodeDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl || '');
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const body = match[3] || '';
  const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
  return { mime, buffer };
}

@Injectable()
export class MediaService {
  private readonly dir = join(process.cwd(), 'storage', 'media');
  private readonly manifestPath = join(this.dir, 'manifest.json');
  private manifest: Record<string, StoredMedia> = {};

  constructor() {
    ensureDir(this.dir);
    if (existsSync(this.manifestPath)) {
      try {
        this.manifest = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Record<string, StoredMedia>;
      } catch {
        this.manifest = {};
      }
    }
  }

  asUrl(mediaId: string) {
    return `http://127.0.0.1:8101/media/${mediaId}`;
  }

  getMedia(mediaId: string) {
    return this.manifest[mediaId] ?? null;
  }

  read(mediaId: string) {
    const meta = this.getMedia(mediaId);
    if (!meta) return null;
    return { meta, buffer: readFileSync(meta.path) };
  }

  async storeFromDataUrl(dataUrl: string, filename = 'media.bin') {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return null;
    return this.storeBuffer(decoded.buffer, decoded.mime, filename);
  }

  async storeFromUrl(url: string, filename = 'media.bin') {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const mime = response.headers.get('content-type') || 'application/octet-stream';
    return this.storeBuffer(Buffer.from(arrayBuffer), mime, filename);
  }

  async storeText(text: string, mime = 'text/plain;charset=utf-8', filename = 'media.txt') {
    return this.storeBuffer(Buffer.from(text, 'utf8'), mime, filename);
  }

  async storeBuffer(buffer: Buffer, mime: string, filename: string) {
    const mediaId = createHash('sha1').update(buffer).update(mime).update(filename).update(randomUUID()).digest('hex');
    const ext = this.extensionForMime(mime);
    const safeName = filename.replace(/[^a-z0-9._-]+/gi, '_') || 'media';
    const outPath = join(this.dir, `${mediaId}-${safeName}${ext}`);
    ensureDir(dirname(outPath));
    writeFileSync(outPath, buffer);

    const record: StoredMedia = {
      mediaId,
      mime,
      filename,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      path: outPath,
    };
    this.manifest[mediaId] = record;
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
    return { ...record, url: this.asUrl(mediaId) };
  }

  private extensionForMime(mime: string) {
    if (mime.includes('svg')) return '.svg';
    if (mime.includes('png')) return '.png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('mp4')) return '.mp4';
    if (mime.includes('json')) return '.json';
    if (mime.includes('text')) return '.txt';
    return '';
  }
}
