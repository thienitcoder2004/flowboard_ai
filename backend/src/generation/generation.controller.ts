import { Body, Controller, Post } from '@nestjs/common';
import { GenerationService } from './generation.service';

@Controller('api/generation')
export class GenerationController {
  constructor(private readonly generation: GenerationService) {}

  @Post('run')
  run(@Body() body: { projectId: string; nodeId: string; provider?: 'mock' | 'google-flow'; videoQuality?: '2k' | '4k' }) {
    return this.generation.generate(body.projectId, body.nodeId, body.provider || 'mock', body.videoQuality);
  }
}
