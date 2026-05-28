import { Module } from '@nestjs/common';
import { BoardController } from './board/board.controller';
import { BoardService } from './board/board.service';
import { FlowboardDbService } from './storage/flowboard-db.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { ExtensionService } from './extension/extension.service';
import { ExtensionController, ExtensionCallbackController } from './extension/extension.controller';
import { GenerationController } from './generation/generation.controller';
import { GenerationService } from './generation/generation.service';

@Module({
  imports: [],
  controllers: [BoardController, MediaController, ExtensionController, ExtensionCallbackController, GenerationController],
  providers: [FlowboardDbService, MediaService, BoardService, ExtensionService, GenerationService],
})
export class AppModule {}
