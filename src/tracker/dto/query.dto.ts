import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const SORTABLE_COLUMNS = [
  'date',
  'company',
  'title',
  'stack',
  'ats_status',
  'sent',
  'cost_usd',
  'ats_verdict',
] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

export const APPLICATION_STATUSES = [
  'applied',
  'sent',
  'failed',
  'expired',
  'pending',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export class QueryApplicationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @IsOptional()
  @IsIn(SORTABLE_COLUMNS)
  sort?: SortableColumn;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(APPLICATION_STATUSES)
  status?: ApplicationStatus;

  @IsOptional()
  @IsString()
  search?: string;
}
