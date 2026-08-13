import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateWebSearchDto } from './dto/update-web-search.dto';
import { SettingsService, WebSearchSettings } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get(@CurrentUser() user: { id: string }): Promise<{ webSearch: WebSearchSettings }> {
    return { webSearch: await this.settings.getWebSearch(user.id) };
  }

  @Put('web-search')
  async setWebSearch(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateWebSearchDto,
  ): Promise<{ webSearch: WebSearchSettings }> {
    return { webSearch: await this.settings.setWebSearch(user.id, dto.enabled) };
  }
}
