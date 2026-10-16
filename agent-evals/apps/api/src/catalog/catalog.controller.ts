import { Controller, Get } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('tasks')
  tasks() {
    return this.catalog.listTasks();
  }

  @Get('configs')
  configs() {
    return this.catalog.listConfigs();
  }
}
