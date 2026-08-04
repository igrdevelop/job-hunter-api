import { IsOptional, IsString } from 'class-validator';

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  sent?: string;

  @IsOptional()
  @IsString()
  to_learn?: string;

  @IsOptional()
  @IsString()
  reapplication?: string;
}
