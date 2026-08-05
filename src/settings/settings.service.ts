import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import {
  CATEGORY_META,
  SETTINGS_SCHEMA,
  SettingDefinition,
} from './settings-schema';

export interface SettingItem {
  key: string;
  value: string | null;
  type: string;
  description: string;
  isDefault: boolean;
  isSecret: boolean;
}

export interface SettingsCategory {
  name: string;
  icon: string;
  settings: SettingItem[];
}

export interface SettingsResponse {
  categories: SettingsCategory[];
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly config: ConfigService) {}

  getAll(): SettingsResponse {
    const env = this.readBotEnv();
    const byCategory = new Map<string, SettingItem[]>();

    for (const def of SETTINGS_SCHEMA) {
      const item = this.toItem(def, env);
      const list = byCategory.get(def.category) ?? [];
      list.push(item);
      byCategory.set(def.category, list);
    }

    const categories: SettingsCategory[] = CATEGORY_META.filter((meta) =>
      byCategory.has(meta.name),
    ).map((meta) => ({
      name: meta.name,
      icon: meta.icon,
      settings: byCategory.get(meta.name)!,
    }));

    return { categories };
  }

  private readBotEnv(): Record<string, string> {
    const envPath = this.config.get<string>('bot.envPath')!;
    if (!existsSync(envPath)) {
      this.logger.warn(`Bot .env not found at ${envPath}; returning schema defaults`);
      return {};
    }
    try {
      return parse(readFileSync(envPath));
    } catch (err) {
      this.logger.error(`Failed to read bot .env at ${envPath}`, err);
      return {};
    }
  }

  private toItem(def: SettingDefinition, env: Record<string, string>): SettingItem {
    const raw = env[def.key];
    const isSet = raw !== undefined && raw !== '';

    if (def.isSecret || def.type === 'secret') {
      return {
        key: def.key,
        value: isSet ? this.maskSecret(raw) : '(not set)',
        type: def.type,
        description: def.description,
        isDefault: !isSet,
        isSecret: true,
      };
    }

    if (!isSet) {
      return {
        key: def.key,
        value: def.defaultValue === '' ? null : def.defaultValue,
        type: def.type,
        description: def.description,
        isDefault: true,
        isSecret: false,
      };
    }

    return {
      key: def.key,
      value: raw,
      type: def.type,
      description: def.description,
      isDefault: false,
      isSecret: false,
    };
  }

  /** Show •••••• + last 6 chars (or just •••••• if shorter). */
  private maskSecret(value: string): string {
    if (value.length <= 6) return '••••••';
    return `••••••${value.slice(-6)}`;
  }
}
