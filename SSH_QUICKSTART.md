# SSH Remote Execution - Quick Start Guide

## What's New

Desktop Commander MCP now supports executing commands on remote SSH servers! This feature enables you to manage remote servers directly through AI conversations using secure public/private key authentication.

## Setup Steps

### 1. Create SSH Credentials File

Create a file named `ssh_servers.json` with your SSH credentials:

```json
{
  "sshCredentials": [
    {
      "name": "my-server",
      "host": "example.com",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_rsa",
      "passphrase": "optional_if_key_encrypted"
    }
  ]
}
```

### 2. Configure MCP Server

Add Desktop Commander to your MCP configuration (`claude_desktop_config.json`) with the `--config` flag:

```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "npx",
      "args": [
        "-y",
        "github:ramgeart/DesktopCommanderMCP",
        "--config",
        "ssh_servers.json"
      ]
    }
  }
}
```

**Note:** Place `ssh_servers.json` in the same directory as your MCP config, or provide the full path.

### 3. Prepare Your SSH Keys

Ensure your SSH key pair is set up:

```bash
# Generate a new SSH key if needed
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"

# Copy your public key to the remote server
ssh-copy-id -i ~/.ssh/id_rsa.pub user@hostname
```

Ask Claude to test your SSH connection:

```
"Test the SSH connection to my-server"
```

This will call `test_ssh_connection("my-server")` to verify connectivity.

## Usage Examples

### Basic Commands

```
"Execute 'ls -la /var/log' on my-server"
"Check disk usage on my-server"
"Show the last 100 lines of /var/log/app.log on my-server"
```

### List Available Servers

```
"Show me all configured SSH servers"
```

### Complex Operations

```
"On my-server, find all log files larger than 100MB"
"Check the status of nginx on my-server and restart it if needed"
"Get system resource usage on my-server"
```

## Available Tools

1. **execute_ssh_command** - Run commands on remote servers
2. **list_ssh_credentials** - View configured servers (without sensitive data)
3. **test_ssh_connection** - Test server connectivity

## Security Notes

- ✅ Uses secure public/private key authentication only
- ✅ No password authentication supported (security best practice)
- ✅ Passphrases can be stored for encrypted keys
- ✅ Private keys never exposed in tool outputs
- ⚠️ Ensure config file has restrictive permissions: `chmod 600 ~/.claude-server-commander/config.json`

## Multiple Servers

You can configure multiple servers for different environments in your `ssh_servers.json` file:

```json
{
  "sshCredentials": [
    {
      "name": "production",
      "host": "prod.example.com",
      "username": "deploy",
      "privateKeyPath": "~/.ssh/prod_key"
    },
    {
      "name": "staging",
      "host": "staging.example.com",
      "username": "deploy",
      "privateKeyPath": "~/.ssh/staging_key"
    },
    {
      "name": "development",
      "host": "dev.example.com",
      "port": 2222,
      "username": "developer",
      "privateKeyPath": "~/.ssh/dev_key"
    }
  ]
}
```

Then reference them by name:
```
"Check logs on production"
"Deploy to staging"
"Run tests on development"
```

## Security Notes

- ✅ Uses secure public/private key authentication only
- ✅ No password authentication supported (security best practice)
- ✅ Passphrases can be stored for encrypted keys
- ✅ Private keys never exposed in tool outputs
- ⚠️ Ensure SSH config file has restrictive permissions: `chmod 600 ssh_servers.json`

### Connection Failed
- Verify host and port are correct
- Check network connectivity: `ping <host>`
- Ensure SSH service is running on remote server

### Authentication Failed
- Verify username is correct
- Check that public key is in `~/.ssh/authorized_keys` on remote server
- Verify private key file exists and has correct permissions (600)
- If using passphrase, verify it's correct

### Command Timeout
- Increase timeout_ms parameter (default: 30000ms)
- Verify command completes when run manually
- Ensure command is non-interactive

## More Information

For complete documentation, see:
- `SSH_REMOTE_EXECUTION.md` - Comprehensive guide
- `config.example.json` - Configuration examples (Note: Use external file with `--config` flag instead)

## Support

Issues? Visit: https://github.com/ramgeart/DesktopCommanderMCP/issues
