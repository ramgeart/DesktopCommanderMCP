import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import os from 'os';
import { VERSION } from './version.js';
import { CONFIG_FILE } from './config.js';

export interface ServerConfig {
  blockedCommands?: string[];
  defaultShell?: string;
  allowedDirectories?: string[];
  fileWriteLineLimit?: number;
  fileReadLineLimit?: number;
  currentClient?: ClientInfo;
  [key: string]: any;
}

export interface ClientInfo {
  name: string;
  version: string;
}

class ConfigManager {
  private configPath: string;
  private config: ServerConfig = {};
  private initialized = false;
  private _isFirstRun = false;

  constructor() {
    this.configPath = CONFIG_FILE;
  }

  async init() {
    if (this.initialized) return;

    try {
      const configDir = path.dirname(this.configPath);
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }

      try {
        await fs.access(this.configPath);
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.config = JSON.parse(configData);
        this._isFirstRun = false;
      } catch (error) {
        this.config = this.getDefaultConfig();
        this._isFirstRun = true;
        await this.saveConfig();
      }
      this.config['version'] = VERSION;
      this.initialized = true;
    } catch (error) {
      this.config = this.getDefaultConfig();
      this.initialized = true;
    }
  }

  async loadConfig() {
    return this.init();
  }

  private getDefaultConfig(): ServerConfig {
    return {
      blockedCommands: [ /* same list as before */ ],
      defaultShell: (() => {
        if (os.platform() === 'win32') return 'powershell.exe';
        const fallbackShell = os.platform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
        return process.env.SHELL || fallbackShell;
      })(),
      allowedDirectories: [],
      fileWriteLineLimit: 50,
      fileReadLineLimit: 1000,
      pendingWelcomeOnboarding: true
    };
  }

  private async saveConfig() {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  async getConfig() {
    await this.init();
    return { ...this.config };
  }

  async getValue(key: string) {
    await this.init();
    return this.config[key];
  }

  async setValue(key: string, value: any) {
    await this.init();
    this.config[key] = value;
    await this.saveConfig();
  }

  /**
   * ID local estable para A/B testing (reemplazo sin telemetría del
   * getOrCreateClientId original: UUID aleatorio persistido en el config
   * local, nunca se envía a ningún lado).
   */
  async getOrCreateClientId(): Promise<string> {
    await this.init();
    let clientId = this.config['clientId'];
    if (typeof clientId !== 'string' || clientId.length === 0) {
      const { randomUUID } = await import('node:crypto');
      clientId = randomUUID();
      this.config['clientId'] = clientId;
      await this.saveConfig();
    }
    return clientId;
  }

  async updateConfig(updates: Partial<ServerConfig>) {
    await this.init();
    this.config = { ...this.config, ...updates };
    await this.saveConfig();
    return { ...this.config };
  }

  async resetConfig() {
    this.config = this.getDefaultConfig();
    await this.saveConfig();
    return { ...this.config };
  }

  isFirstRun() {
    return this._isFirstRun;
  }
}

export const configManager = new ConfigManager();
