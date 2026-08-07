import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';

@Roles('admin')
@UseGuards(RolesGuard)
@Controller('admin/users')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list() {
    return this.admin.listUsers();
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { disabled?: boolean }) {
    return this.admin.updateUser(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    const deleted = this.admin.deleteUser(id);
    if (!deleted) throw new NotFoundException('User not found');
    return { ok: true };
  }
}
