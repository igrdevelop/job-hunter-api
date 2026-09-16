import { IsBoolean, ValidateIf } from 'class-validator';

export class UpdateUserDto {
  // Optional, but when the key is present it must be a real boolean: a
  // string like "false" is truthy and used to DISABLE the account. Plain
  // @IsOptional() would also let an explicit null through, so only skip
  // validation when the key is absent.
  @ValidateIf((o: UpdateUserDto) => o.disabled !== undefined)
  @IsBoolean()
  disabled?: boolean;
}
