import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const SORTABLE_COLUMNS = [
  'date',
  'company',
  'title',
  'stack',
  'atsStatus',
  'sent',
  'costUsd',
  'atsVerdict',
] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

// Maps the camelCase wire-contract sort keys to the real snake_case
// columns in the bot's tracker.db schema.
export const SORT_COLUMN_MAP: Record<SortableColumn, string> = {
  date: 'date',
  company: 'company',
  title: 'title',
  stack: 'stack',
  atsStatus: 'ats_status',
  sent: 'sent',
  costUsd: 'cost_usd',
  atsVerdict: 'ats_verdict',
};

export const SENT_FILTERS = ['unsent', 'filled'] as const;
export type SentFilter = (typeof SENT_FILTERS)[number];

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
  @IsIn(SENT_FILTERS)
  status?: SentFilter;

  @IsOptional()
  @IsString()
  search?: string;
}
