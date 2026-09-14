import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { APP_STATUS_OPTIONS, OWNER_REASON_CODES } from '../app-status';

// '' is always a valid ownerReason (means "no reason set / clear it") — the
// per-status allowance for a non-empty code is checked in
// TrackerService.updateApplication, where the resulting status (this body's
// appStatus, else the current row's) is known.
const OWNER_REASON_VALUES = ['', ...OWNER_REASON_CODES];

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
  @IsIn(OWNER_REASON_VALUES)
  ownerReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  ownerReasonNote?: string;
}
