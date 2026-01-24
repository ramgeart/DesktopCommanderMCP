# SSH Remote Execution

Desktop Commander MCP now supports executing commands on remote SSH servers using secure public/private key authentication.

## Overview

The SSH remote execution feature allows you to:
- Execute commands on remote servers via SSH
- Manage multiple SSH credentials
- Use secure public/private key authentication
- Test SSH connections before executing commands

## Configuration

SSH credentials are configured in the server configuration file (`~/.claude-server-commander/config.json`). You can add multiple credentials for different servers.

### Configuration Structure

```json
{
  "sshCredentials": [
    {
      "name": "production-server",
      "host": "prod.example.com",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_rsa",
      "passphrase": "optional_passphrase"
    },
    {
      "name": "staging-server",
      "host": "staging.example.com",
      "port": 2222,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/staging_key"
    }
  ]
}
```

### Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for the credential (used in commands) |
| `host` | Yes | SSH server hostname or IP address |
| `port` | No | SSH port (default: 22) |
| `username` | Yes | SSH username |
| `privateKeyPath` | Yes | Path to private key file (supports `~/` home directory) |
| `passphrase` | No | Passphrase for encrypted private keys |

## Available Tools

### 1. execute_ssh_command

Execute a command on a remote SSH server.

**Parameters:**
- `credential_name` (string, required): Name of the SSH credential from configuration
- `command` (string, required): Command to execute on the remote server
- `timeout_ms` (number, optional): Timeout in milliseconds (default: 30000)

**Example:**
```javascript
{
  "credential_name": "production-server",
  "command": "ls -la /var/log",
  "timeout_ms": 60000
}
```

**Returns:**
- Standard output (stdout)
- Standard error (stderr)
- Exit code
- Signal (if applicable)

### 2. list_ssh_credentials

List all configured SSH credentials without exposing sensitive data.

**Parameters:** None

**Returns:**
List of credentials with:
- Credential name
- Host
- Username

**Note:** Private keys and passphrases are never exposed in the output.

### 3. test_ssh_connection

Test connectivity to a remote SSH server.

**Parameters:**
- `credential_name` (string, required): Name of the SSH credential to test

**Returns:**
- Success/failure status
- Connection details or error message

## Usage Examples

### Basic Command Execution

Execute a simple command on a remote server:

```bash
# List files in /var/log
execute_ssh_command("production-server", "ls -la /var/log")

# Check disk usage
execute_ssh_command("staging-server", "df -h")

# View last 100 lines of a log file
execute_ssh_command("production-server", "tail -n 100 /var/log/app.log")
```

### With Timeout

Execute a long-running command with a custom timeout:

```bash
# Long-running backup operation (2 minutes timeout)
execute_ssh_command("production-server", "/scripts/backup.sh", 120000)
```

### Testing Connections

Before executing commands, test the connection:

```bash
# Test connection to production server
test_ssh_connection("production-server")
```

### Listing Available Credentials

See which SSH credentials are configured:

```bash
# List all configured SSH credentials
list_ssh_credentials()
```

## Security Considerations

### Key-Based Authentication

- **Only public/private key authentication is supported** - no password authentication
- Keys must be accessible from the file system where Desktop Commander is running
- Private keys should have appropriate file permissions (typically 600)

### Passphrase-Protected Keys

- Passphrases can be stored in the configuration file
- Store passphrases securely - the config file should have restrictive permissions
- Consider using SSH agent instead of storing passphrases

### File Permissions

Ensure your SSH configuration file has appropriate permissions:

```bash
# Set restrictive permissions on config file
chmod 600 ~/.claude-server-commander/config.json

# Set restrictive permissions on private keys
chmod 600 ~/.ssh/id_rsa
```

### Best Practices

1. **Use dedicated keys**: Create separate SSH keys for Desktop Commander
2. **Limit permissions**: Configure SSH server to restrict what each key can do
3. **Regular rotation**: Rotate SSH keys periodically
4. **Audit access**: Monitor SSH access logs on remote servers
5. **Principle of least privilege**: Only grant necessary permissions

## Troubleshooting

### Connection Failed

**Problem:** Cannot connect to SSH server

**Solutions:**
1. Verify the host and port are correct
2. Check network connectivity: `ping <host>`
3. Verify SSH service is running on the remote server
4. Test connection manually: `ssh -p <port> <username>@<host>`
5. Check firewall rules

### Authentication Failed

**Problem:** Authentication errors

**Solutions:**
1. Verify the username is correct
2. Check that the private key file exists and is readable
3. Verify the public key is in `~/.ssh/authorized_keys` on the remote server
4. Check private key permissions (should be 600)
5. If using passphrase, verify it's correct
6. Test key manually: `ssh -i <key_path> <username>@<host>`

### Command Timeout

**Problem:** Commands timing out

**Solutions:**
1. Increase timeout_ms parameter
2. Verify the command completes successfully when run manually
3. Check if the command is waiting for input (SSH commands should be non-interactive)
4. Monitor network latency

### Key Not Found

**Problem:** "Private key file not found" error

**Solutions:**
1. Verify the path in `privateKeyPath` is correct
2. If using `~/`, ensure it resolves correctly
3. Use absolute paths for clarity
4. Check file permissions

## Advanced Usage

### Multiple Server Management

Configure credentials for different environments:

```json
{
  "sshCredentials": [
    {
      "name": "prod-web1",
      "host": "web1.prod.example.com",
      "username": "deploy",
      "privateKeyPath": "~/.ssh/prod_key"
    },
    {
      "name": "prod-web2",
      "host": "web2.prod.example.com",
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
      "name": "dev",
      "host": "dev.example.com",
      "port": 2222,
      "username": "developer",
      "privateKeyPath": "~/.ssh/dev_key"
    }
  ]
}
```

### Command Chaining

Execute multiple commands in sequence:

```bash
# Check status, restart service, verify
execute_ssh_command("production-server", "systemctl status nginx")
execute_ssh_command("production-server", "sudo systemctl restart nginx")
execute_ssh_command("production-server", "systemctl status nginx")
```

### Complex Commands

Execute complex shell commands:

```bash
# Find and count files
execute_ssh_command("production-server", 
  "find /var/log -name '*.log' -type f | wc -l")

# Disk usage analysis
execute_ssh_command("production-server",
  "du -sh /var/www/* | sort -rh | head -10")

# Monitor system resources
execute_ssh_command("production-server",
  "top -b -n 1 | head -20")
```

## Limitations

1. **Interactive commands not supported**: Commands requiring user input will not work properly
2. **Session persistence**: Each command creates a new SSH session
3. **File transfers**: Use `scp` or `rsync` commands, or consider dedicated file transfer tools
4. **Terminal features**: Advanced terminal features may not work as expected

## Future Enhancements

Potential future improvements:
- Persistent SSH sessions for multiple commands
- Built-in file transfer capabilities
- SSH agent support
- Jump host/bastion support
- Parallel command execution across multiple servers

## Related Documentation

- [Terminal Command Execution](./README.md#terminal-commands)
- [Configuration Management](./FAQ.md#configuration)
- [Security Best Practices](./SECURITY.md)
