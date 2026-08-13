import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';

export interface WebSearchSettings {
  serverEnabled: boolean;
  enabled: boolean;
}

/**
 * Per-user feature settings, stored as Redis flags (short-lived, mirrored like
 * user API keys). The server-level kill-switch (WEB_SEARCH_ENABLED env) is
 * reported so the UI can explain why the toggle is locked.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly webSearchTtl = 60 * 60 * 24 * 30; // 30 days

  constructor(private readonly redis: RedisService) {}

  webSearchKey(userId: string): string {
    return `rag:user_setting:${userId}:web_search`;
  }

  serverWebSearchEnabled(): boolean {
    return process.env.WEB_SEARCH_ENABLED === 'true';
  }

  async getWebSearch(userId: string): Promise<WebSearchSettings> {
    const serverEnabled = this.serverWebSearchEnabled();
    let enabled = false;
    if (serverEnabled) {
      try {
        enabled = (await this.redis.get(this.webSearchKey(userId))) === '1';
      } catch (err) {
        this.logger.warn(`web search setting lookup failed: ${err}`);
      }
    }
    return { serverEnabled, enabled };
  }

  async setWebSearch(userId: string, enabled: boolean): Promise<WebSearchSettings> {
    const serverEnabled = this.serverWebSearchEnabled();
    if (!serverEnabled) {
      return { serverEnabled, enabled: false };
    }
    try {
      if (enabled) {
        await this.redis.set(this.webSearchKey(userId), '1', this.webSearchTtl);
      } else {
        await this.redis.del(this.webSearchKey(userId));
      }
    } catch (err) {
      this.logger.warn(`web search setting write failed: ${err}`);
      throw err;
    }
    return { serverEnabled, enabled };
  }
}
