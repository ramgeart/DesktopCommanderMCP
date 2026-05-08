import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { CONFIG_FILE } from '../config.js';
import { logger } from './logger.js';

interface FeatureFlags {
  version?: string;
  flags?: Record<string, any>;
}

class FeatureFlagManager {
  private flags: Record<string, any> = {};
  private lastFetch: number = 0;
  private cachePath: string;
  private cacheMaxAge: number = 30 * 60 * 1000;
  
  // No more remote URL - fully local only
  constructor() {
    const configDir = path.dirname(CONFIG_FILE);
    this.cachePath = path.join(configDir, 'feature-flags.json');
    
    logger.info('Feature flags initialized (local-only mode - no network calls)');
  }

  /**
   * Initialize - load from cache only (no network)
   */
  async initialize(): Promise<void> {
    try {
      await this.loadFromCache();
      logger.info(`Feature flags loaded (${Object.keys(this.flags).length} flags from local cache)`);
    } catch (error) {
      logger.warning('Failed to initialize feature flags:', error);
    }
  }

  /**
   * Get a flag value
   */
  get(flagName: string, defaultValue: any = false): any {
    return this.flags[flagName] !== undefined ? this.flags[flagName] : defaultValue;
  }

  /**
   * Get all flags for debugging
   */
  getAll(): Record<string, any> {
    return { ...this.flags };
  }

  /**
   * Manually refresh - now just reloads cache (no network)
   */
  async refresh(): Promise<boolean> {
    try {
      await this.loadFromCache();
      return true;
    } catch (error) {
      logger.error('Manual refresh failed:', error);
      return false;
    }
  }

  /**
   * Check if flags were loaded from cache
   */
  wasLoadedFromCache(): boolean {
    return true;
  }

  /**
   * Wait for flags - immediate since local only
   */
  async waitForFreshFlags(): Promise<void> {
    // No-op - already local
    return;
  }

  /**
   * Load flags from local cache only
   */
  private async loadFromCache(): Promise<void> {
    try {
      if (!existsSync(this.cachePath)) {
        logger.debug('No feature flag cache found - using empty defaults');
        this.flags = {};
        return;
      }

      const data = await fs.readFile(this.cachePath, 'utf8');
      const config: FeatureFlags = JSON.parse(data);
      
      if (config.flags) {
        this.flags = config.flags;
        this.lastFetch = Date.now();
        logger.debug(`Loaded ${Object.keys(this.flags).length} feature flags from cache`);
      }
    } catch (error) {
      logger.warning('Failed to load feature flags from cache:', error);
      this.flags = {};
    }
  }

  /**
   * No-op - no remote fetch ever
   */
  private async fetchFlags(): Promise<void> {
    // Completely disabled - no network calls to desktopcommander.app
    logger.debug('Remote feature flags disabled in clean fork');
    return;
  }

  /**
   * Save flags to local cache (kept for compatibility)
   */
  private async saveToCache(config: FeatureFlags): Promise<void> {
    try {
      const configDir = path.dirname(this.cachePath);
      if (!existsSync(configDir)) {
        await fs.mkdir(configDir, { recursive: true });
      }
      
      await fs.writeFile(this.cachePath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      logger.warning('Failed to save feature flags to cache:', error);
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    // No interval anymore
  }
}

// Export singleton instance
export const featureFlagManager = new FeatureFlagManager();
