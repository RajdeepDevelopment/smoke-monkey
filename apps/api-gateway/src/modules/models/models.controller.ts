import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';

@Controller('models')
export class ModelsController {
  private readonly logger = new Logger(ModelsController.name);
  private readonly ragUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

  @Get()
  async getModels(): Promise<{
    providers: { id: string; label: string; models: string[] }[];
    defaultProvider: string;
  }> {
    const upstream = await fetch(`${this.ragUrl}/api/v1/models`, {
      headers: { 'content-type': 'application/json' },
    });
    if (!upstream.ok) {
      this.logger.error(`rag-service /models responded with ${upstream.status}`);
      throw new ServiceUnavailableException('models unavailable');
    }
    return upstream.json();
  }
}
