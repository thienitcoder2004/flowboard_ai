import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { BoardService } from './board.service';

@Controller('api/projects')
export class BoardController {
  constructor(private readonly board: BoardService) {}

  @Get()
  list() { return this.board.listProjects(); }

  @Post()
  create(@Body() body: { name?: string }) { return this.board.createProject(body.name); }

  @Get(':projectId')
  get(@Param('projectId') projectId: string) { return this.board.getProject(projectId); }

  @Post(':projectId/nodes')
  addNode(@Param('projectId') projectId: string, @Body() body: any) { return this.board.addNode(projectId, body); }

  @Patch(':projectId/nodes/:nodeId')
  updateNode(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @Body() body: any) { return this.board.updateNode(projectId, nodeId, body); }

  @Post(':projectId/edges')
  addEdge(@Param('projectId') projectId: string, @Body() body: any) { return this.board.addEdge(projectId, body); }

    @Delete(':projectId/nodes/:nodeId')
  deleteNode(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string) {
    return this.board.deleteNode(projectId, nodeId);
  }

  @Delete(':projectId/edges/:edgeId')
  deleteEdge(@Param('projectId') projectId: string, @Param('edgeId') edgeId: string) {
    return this.board.deleteEdge(projectId, edgeId);
  }
}
