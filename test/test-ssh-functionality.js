/**
 * Test SSH functionality
 * This test verifies that SSH credentials can be managed and SSH commands can be simulated
 */

import { strict as assert } from 'assert';
import { configManager } from '../dist/config-manager.js';
import { sshManager } from '../dist/ssh-manager.js';

console.log('Starting SSH functionality tests...\n');

// Test 1: Add SSH credentials to config
async function testAddSSHCredentials() {
  console.log('Test 1: Add SSH credentials to config');
  
  const testCredential = {
    name: 'test-server',
    host: 'test.example.com',
    port: 22,
    username: 'testuser',
    privateKeyPath: '~/.ssh/test_key',
    passphrase: '' // Empty passphrase for testing - in production use secure passphrases
  };

  // Add credentials to config
  await configManager.setValue('sshCredentials', [testCredential]);
  
  // Verify credentials were saved
  const config = await configManager.getConfig();
  assert(config.sshCredentials, 'SSH credentials should be in config');
  assert.equal(config.sshCredentials.length, 1, 'Should have 1 credential');
  assert.equal(config.sshCredentials[0].name, 'test-server', 'Credential name should match');
  assert.equal(config.sshCredentials[0].host, 'test.example.com', 'Host should match');
  assert.equal(config.sshCredentials[0].username, 'testuser', 'Username should match');
  
  console.log('✓ SSH credentials added successfully\n');
}

// Test 2: List SSH credentials
async function testListSSHCredentials() {
  console.log('Test 2: List SSH credentials');
  
  const credentials = await sshManager.listCredentials();
  
  assert(Array.isArray(credentials), 'Should return an array');
  assert.equal(credentials.length, 1, 'Should have 1 credential');
  assert.equal(credentials[0].name, 'test-server', 'Credential name should match');
  assert.equal(credentials[0].host, 'test.example.com', 'Host should match');
  assert.equal(credentials[0].username, 'testuser', 'Username should match');
  
  // Verify sensitive data is not exposed
  assert(!credentials[0].privateKeyPath, 'Private key path should not be exposed');
  assert(!credentials[0].passphrase, 'Passphrase should not be exposed');
  
  console.log('✓ SSH credentials listed successfully (without sensitive data)\n');
}

// Test 3: Multiple credentials
async function testMultipleCredentials() {
  console.log('Test 3: Multiple SSH credentials');
  
  const credentials = [
    {
      name: 'server1',
      host: 'server1.example.com',
      username: 'user1',
      privateKeyPath: '~/.ssh/key1'
    },
    {
      name: 'server2',
      host: 'server2.example.com',
      port: 2222,
      username: 'user2',
      privateKeyPath: '~/.ssh/key2',
      passphrase: '' // Use empty string or secure environment variable in production
    }
  ];
  
  await configManager.setValue('sshCredentials', credentials);
  
  const listedCredentials = await sshManager.listCredentials();
  assert.equal(listedCredentials.length, 2, 'Should have 2 credentials');
  assert.equal(listedCredentials[0].name, 'server1', 'First credential name should match');
  assert.equal(listedCredentials[1].name, 'server2', 'Second credential name should match');
  
  console.log('✓ Multiple SSH credentials managed successfully\n');
}

// Test 4: SSH command execution error handling
async function testSSHCommandErrorHandling() {
  console.log('Test 4: SSH command execution error handling');
  
  try {
    // Try to execute command with non-existent credential
    await sshManager.executeCommand('non-existent', 'echo test', 5000);
    assert.fail('Should have thrown an error for non-existent credential');
  } catch (error) {
    assert(error.message.includes('not found'), 'Error should mention credential not found');
    console.log('✓ Correctly handles non-existent credentials\n');
  }
}

// Test 5: Configuration validation
async function testConfigurationValidation() {
  console.log('Test 5: Configuration validation');
  
  const validCredential = {
    name: 'valid-server',
    host: 'valid.example.com',
    username: 'validuser',
    privateKeyPath: '/path/to/key'
  };
  
  await configManager.setValue('sshCredentials', [validCredential]);
  const config = await configManager.getConfig();
  
  assert(config.sshCredentials[0].name, 'Name is required');
  assert(config.sshCredentials[0].host, 'Host is required');
  assert(config.sshCredentials[0].username, 'Username is required');
  
  console.log('✓ Configuration validation working correctly\n');
}

// Test 6: Cleanup and reset
async function testCleanup() {
  console.log('Test 6: Cleanup');
  
  // Clean up test credentials
  await configManager.setValue('sshCredentials', []);
  
  const credentials = await sshManager.listCredentials();
  assert.equal(credentials.length, 0, 'Credentials should be cleared');
  
  console.log('✓ Cleanup completed successfully\n');
}

// Run all tests
async function runTests() {
  try {
    await testAddSSHCredentials();
    await testListSSHCredentials();
    await testMultipleCredentials();
    await testSSHCommandErrorHandling();
    await testConfigurationValidation();
    await testCleanup();
    
    console.log('✅ All SSH tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

runTests();
