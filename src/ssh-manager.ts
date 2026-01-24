import { Client, ConnectConfig } from 'ssh2';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { configManager, SSHCredential } from './config-manager.js';
import { capture } from './utils/capture.js';

export interface SSHSession {
  connectionId: string;
  credentialName: string;
  client: Client;
  connected: boolean;
  lastUsed: Date;
}

export interface SSHCommandResult {
  connectionId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
}

/**
 * Manager for SSH connections and remote command execution
 */
export class SSHManager {
  private sessions: Map<string, SSHSession> = new Map();
  private connectionCounter = 0;

  /**
   * Get SSH credential by name from config
   */
  private async getCredential(name: string): Promise<SSHCredential | null> {
    const config = await configManager.getConfig();
    if (!config.sshCredentials || config.sshCredentials.length === 0) {
      return null;
    }

    return config.sshCredentials.find(cred => cred.name === name) || null;
  }

  /**
   * Create SSH connection using credential
   */
  private async createConnection(credential: SSHCredential): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      
      const connectConfig: ConnectConfig = {
        host: credential.host,
        port: credential.port || 22,
        username: credential.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      };

      // Handle private key authentication
      if (credential.privateKeyPath) {
        // Resolve ~ to home directory if present
        let keyPath = credential.privateKeyPath;
        if (keyPath.startsWith('~/')) {
          keyPath = path.join(os.homedir(), keyPath.substring(2));
        }
        
        // Check if key file exists
        if (!existsSync(keyPath)) {
          reject(new Error(`Private key file not found: ${keyPath}`));
          return;
        }

        // Read the private key
        fs.readFile(keyPath, 'utf8')
          .then(privateKey => {
            connectConfig.privateKey = privateKey;
            if (credential.passphrase) {
              connectConfig.passphrase = credential.passphrase;
            }
            
            this.connectWithConfig(client, connectConfig, resolve, reject);
          })
          .catch(err => {
            reject(new Error(`Failed to read private key: ${err.message}`));
          });
      } else {
        // No key provided - this will fail but let SSH2 handle the error
        this.connectWithConfig(client, connectConfig, resolve, reject);
      }
    });
  }

  /**
   * Helper to establish connection with error handling
   */
  private connectWithConfig(
    client: Client,
    config: ConnectConfig,
    resolve: (client: Client) => void,
    reject: (error: Error) => void
  ): void {
    client.on('ready', () => {
      resolve(client);
    });

    client.on('error', (err) => {
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    try {
      client.connect(config);
    } catch (err) {
      reject(new Error(`Failed to initiate SSH connection: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /**
   * Execute command on remote SSH server
   */
  async executeCommand(
    credentialName: string,
    command: string,
    timeoutMs: number = 30000
  ): Promise<SSHCommandResult> {
    // Get credential
    const credential = await this.getCredential(credentialName);
    if (!credential) {
      throw new Error(`SSH credential '${credentialName}' not found in configuration`);
    }

    let client: Client | null = null;
    const connectionId = `ssh-${++this.connectionCounter}`;

    try {
      // Create connection
      client = await this.createConnection(credential);
      
      // Store session
      const session: SSHSession = {
        connectionId,
        credentialName,
        client,
        connected: true,
        lastUsed: new Date()
      };
      this.sessions.set(connectionId, session);

      // Execute command with timeout
      const result = await this.executeOnClient(client, command, timeoutMs);
      
      capture('ssh_command_success', {
        credentialName,
        command: command.substring(0, 50)
      });

      return {
        connectionId,
        ...result
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      capture('ssh_command_error', {
        credentialName,
        error: errorMessage
      });

      throw new Error(`SSH command execution failed: ${errorMessage}`);
    } finally {
      // Close connection after command execution
      if (client) {
        try {
          client.end();
        } catch (err) {
          // Ignore errors during cleanup
        }
      }
      if (this.sessions.has(connectionId)) {
        this.sessions.delete(connectionId);
      }
    }
  }

  /**
   * Execute command on an established SSH client
   */
  private executeOnClient(
    client: Client,
    command: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal?: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let signal: string | undefined;
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Command execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number, sig?: string) => {
          if (timedOut) return;
          
          clearTimeout(timeout);
          exitCode = code;
          signal = sig;
          
          resolve({
            stdout,
            stderr,
            exitCode,
            signal
          });
        });

        stream.on('error', (streamErr: Error) => {
          if (timedOut) return;
          
          clearTimeout(timeout);
          reject(streamErr);
        });
      });
    });
  }

  /**
   * List all SSH credentials configured (without sensitive data)
   */
  async listCredentials(): Promise<Array<{ name: string; host: string; username: string }>> {
    const config = await configManager.getConfig();
    if (!config.sshCredentials || config.sshCredentials.length === 0) {
      return [];
    }

    return config.sshCredentials.map(cred => ({
      name: cred.name,
      host: cred.host,
      username: cred.username
    }));
  }

  /**
   * Test SSH connection
   */
  async testConnection(credentialName: string): Promise<{ success: boolean; message: string }> {
    try {
      const credential = await this.getCredential(credentialName);
      if (!credential) {
        return {
          success: false,
          message: `SSH credential '${credentialName}' not found in configuration`
        };
      }

      const client = await this.createConnection(credential);
      
      // Execute a simple test command
      const result = await this.executeOnClient(client, 'echo "connection test"', 5000);
      
      client.end();

      return {
        success: true,
        message: `Successfully connected to ${credential.host} as ${credential.username}`
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Cleanup all sessions
   */
  cleanup(): void {
    for (const [connectionId, session] of this.sessions.entries()) {
      try {
        session.client.end();
      } catch (err) {
        // Ignore cleanup errors
      }
      this.sessions.delete(connectionId);
    }
  }
}

// Export singleton instance
export const sshManager = new SSHManager();
