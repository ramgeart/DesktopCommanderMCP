#!/usr/bin/env node

import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server, flushDeferredMessages } from './server.js';
import { commandManager } from './command-manager.js';
import { configManager } from './config-manager.js';
import { featureFlagManager } from './utils/feature-flags.js';
import { runSetup } from './npm-scripts/setup.js';
import { runUninstall } from './npm-scripts/uninstall.js';
import { logToStderr, logger } from './utils/logger.js';
import { runRemote } from './npm-scripts/remote.js';
import { ensureChromeAvailable } from './tools/pdf/markdown.js';

// Store messages to defer until after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
function deferLog(level: string, message: string) {
  deferredMessages.push({ level, message });
}

async function runServer() {
  try {
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }

    if (process.argv[2] === 'remove') {
      await runUninstall();
      return;
    }

    if (process.argv[2] === 'remote') {
      await runRemote();
      return;
    }

    const DISABLE_ONBOARDING = process.argv.includes('--no-onboarding');
    if (DISABLE_ONBOARDING) {
      logToStderr('info', 'Onboarding disabled via --no-onboarding flag');
    }

    (global as any).disableOnboarding = DISABLE_ONBOARDING;

    const transport = new FilteredStdioServerTransport();
    global.mcpTransport = transport;

    try {
      deferLog('info', 'Loading configuration...');
      await configManager.loadConfig();
      deferLog('info', 'Configuration loaded successfully');

      deferLog('info', 'Initializing feature flags...');
      await featureFlagManager.initialize();
    } catch (configError) {
      deferLog('error', `Failed to load configuration: ${configError}`);
      deferLog('warning', 'Continuing with in-memory configuration only');
    }

    process.on('uncaughtException', (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Uncaught exception: ${errorMessage}`);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      const errorMessage = String(reason);
      logger.error(`Unhandled rejection: ${errorMessage}`);
      process.exit(1);
    });

    server.oninitialized = () => {
      transport.enableNotifications();
      while (deferredMessages.length > 0) {
        const msg = deferredMessages.shift()!;
        transport.sendLog('info', msg.message);
      }
      flushDeferredMessages();
      transport.sendLog('info', 'Server connected successfully');
      ensureChromeAvailable();
    };

    await server.connect(transport);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`FATAL ERROR: ${errorMessage}`);
    process.exit(1);
  }
}

runServer().catch((error) => {
  console.error(`RUNTIME ERROR: ${error}`);
  process.exit(1);
});
