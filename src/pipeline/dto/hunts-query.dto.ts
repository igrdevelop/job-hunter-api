import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query string → number, except that an explicitly EMPTY value (`?offset=`)
 * becomes NaN and fails `@IsInt()` — `@Type(() => Number)` would turn it into
 * 0 and silently serve the default. Only an omitted param takes the default.
 */
const toNumber = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? NaN : Number(value),
  );

/**
 * `?days=1|7&offset=&limit=` — one page of every hunt started in the last
 * `days` Warsaw calendar days (1 = today), newest first.
 */
export class HuntsQueryDto {
  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  @Max(30)
  days: number = 1;

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(0)
  offset: number = 0;

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
