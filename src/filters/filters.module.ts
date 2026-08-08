import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';

@Module({
  imports: [UsersModule],
  controllers: [FiltersController],
  providers: [FiltersService],
})
export class FiltersModule {}
