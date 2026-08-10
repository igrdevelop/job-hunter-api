import { IsOptional, IsString } from 'class-validator';

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  sent?: string;

  @IsOptional()
  @IsString()
  toLearn?: string;

  @IsOptional()
  @IsString()
  appStatus?: string;
}
