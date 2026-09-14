import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { APP_STATUS_OPTIONS } from '../app-status';

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  sent?: string;

  @IsOptional()
  @IsString()
  toLearn?: string;

  @IsOptional()
  @IsString()
  reapplication?: string;

  @IsOptional()
  @IsIn(APP_STATUS_OPTIONS)
  appStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
