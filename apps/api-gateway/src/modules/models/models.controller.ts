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

  @Get('omniroute')
  async getOmniRouteModels(): Promise<{ reachable: boolean; models: unknown[] }> {
    // Live free/keyless model list from the local OmniRoute gateway. Best-effort:
    // when the gateway is offline we return an empty, unreachable payload and the
    // UI falls back to the curated list already present in GET /models.
    try {
      const upstream = await fetch(`${this.ragUrl}/api/v1/omniroute/models`, {
        headers: { 'content-type': 'application/json' },
      });
      if (!upstream.ok) {
        this.logger.warn(`rag-service /omniroute/models responded with ${upstream.status}`);
        return { reachable: false, models: [] };
      }
      return (await upstream.json()) as { reachable: boolean; models: unknown[] };
    } catch (err) {
      this.logger.warn(`omniroute models lookup failed: ${err}`);
      return { reachable: false, models: [] };
    }
  }
}
