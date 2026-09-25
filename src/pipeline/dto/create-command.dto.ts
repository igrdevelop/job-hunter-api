import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** The `bot_commands.kind` whitelist (shared contract with the bot's drain). */
export const BOT_COMMAND_KINDS = [
  'hunt',
  'retry_failed',
  'check_expired',
] as const;
export type BotCommandKind = (typeof BOT_COMMAND_KINDS)[number];

/**
 * `POST /api/pipeline/commands`. `sources` is meaningful for `hunt` only
 * (`null`/absent = every source); the service rejects it on other kinds and
 * checks each name against the bot's `bot_state.sources`.
 */
export class CreateCommandDto {
  @IsIn(BOT_COMMAND_KINDS)
  kind!: BotCommandKind;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  sources?: string[] | null;
}
