import { sshManager } from '../ssh-manager.js';
import { 
  ExecuteSSHCommandArgsSchema, 
  ListSSHCredentialsArgsSchema,
  TestSSHConnectionArgsSchema 
} from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture } from '../utils/capture.js';

/**
 * Execute command on remote SSH server
 */
export async function handleExecuteSSHCommand(args: unknown): Promise<ServerResult> {
  const parsed = ExecuteSSHCommandArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('ssh_execute_command_invalid_args');
    return {
      content: [{
        type: "text",
        text: `Invalid arguments: ${parsed.error.message}`
      }],
      isError: true
    };
  }

  // Check if credentials are loaded
  if (!sshManager.hasCredentials()) {
    return {
      content: [{
        type: "text",
        text: 'No SSH credentials loaded. Please provide a config file using the --config flag when starting the server.'
      }],
      isError: true
    };
  }

  const { credential_name, command, timeout_ms } = parsed.data;

  try {
    const result = await sshManager.executeCommand(credential_name, command, timeout_ms);

    let outputText = '';
    
    if (result.stdout) {
      outputText += `STDOUT:\n${result.stdout}\n`;
    }
    
    if (result.stderr) {
      outputText += `\nSTDERR:\n${result.stderr}\n`;
    }

    outputText += `\nExit Code: ${result.exitCode ?? 'N/A'}`;
    
    if (result.signal) {
      outputText += `\nSignal: ${result.signal}`;
    }

    return {
      content: [{
        type: "text",
        text: outputText || '(No output)'
      }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `SSH command execution failed: ${errorMessage}`
      }],
      isError: true
    };
  }
}

/**
 * List available SSH credentials
 */
export async function handleListSSHCredentials(args: unknown): Promise<ServerResult> {
  const parsed = ListSSHCredentialsArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('ssh_list_credentials_invalid_args');
    return {
      content: [{
        type: "text",
        text: `Invalid arguments: ${parsed.error.message}`
      }],
      isError: true
    };
  }

  try {
    // Check if credentials are loaded
    if (!sshManager.hasCredentials()) {
      return {
        content: [{
          type: "text",
          text: 'No SSH credentials loaded. Please provide a config file using the --config flag when starting the server.'
        }]
      };
    }

    const credentials = sshManager.listCredentials();

    if (credentials.length === 0) {
      return {
        content: [{
          type: "text",
          text: 'No SSH credentials configured in the config file.'
        }]
      };
    }

    const credentialsList = credentials.map((cred, index) => 
      `${index + 1}. ${cred.name} - ${cred.username}@${cred.host}`
    ).join('\n');

    return {
      content: [{
        type: "text",
        text: `Available SSH Credentials:\n\n${credentialsList}`
      }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `Failed to list SSH credentials: ${errorMessage}`
      }],
      isError: true
    };
  }
}

/**
 * Test SSH connection
 */
export async function handleTestSSHConnection(args: unknown): Promise<ServerResult> {
  const parsed = TestSSHConnectionArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('ssh_test_connection_invalid_args');
    return {
      content: [{
        type: "text",
        text: `Invalid arguments: ${parsed.error.message}`
      }],
      isError: true
    };
  }

  // Check if credentials are loaded
  if (!sshManager.hasCredentials()) {
    return {
      content: [{
        type: "text",
        text: 'No SSH credentials loaded. Please provide a config file using the --config flag when starting the server.'
      }],
      isError: true
    };
  }

  const { credential_name } = parsed.data;

  try {
    const result = await sshManager.testConnection(credential_name);

    return {
      content: [{
        type: "text",
        text: result.success 
          ? `✅ ${result.message}`
          : `❌ ${result.message}`
      }],
      isError: !result.success
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `SSH connection test failed: ${errorMessage}`
      }],
      isError: true
    };
  }
}
