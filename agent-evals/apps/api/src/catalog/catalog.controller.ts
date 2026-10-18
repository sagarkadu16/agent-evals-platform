import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('tasks')
  tasks() {
    return this.catalog.listTasks();
  }

  /** Any task, including inactive ones, so old runs can still show their prompt. */
  @Get('tasks/:id')
  task(@Param('id') id: string) {
    const task = this.catalog.getTask(id);
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return task;
  }

  @Get('configs')
  configs() {
    return this.catalog.listConfigs();
  }
}
