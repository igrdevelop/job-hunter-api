import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { UpdateUserDto } from './dto/update-user.dto';

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
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ) {
    // An admin disabling their own account would lock a single-admin
    // deployment out of administration. Re-enabling (a no-op for a caller
    // who is necessarily enabled) stays allowed.
    if (id === user.id && body.disabled === true) {
      throw new ForbiddenException('Admins cannot disable their own account');
    }
    const updated = this.admin.updateUser(id, body);
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    if (id === user.id) {
      throw new ForbiddenException('Admins cannot delete their own account');
    }
    const deleted = this.admin.deleteUser(id);
    if (!deleted) throw new NotFoundException('User not found');
    return { ok: true };
  }
}
