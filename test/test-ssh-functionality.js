/**
 * Test SSH functionality
 * This test verifies that SSH credentials can be loaded from external config file
 */

import { strict as assert } from 'assert';
import { sshManager } from '../dist/ssh-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Starting SSH functionality tests...\n');

// Create a temporary config file for testing
const testConfigPath = path.join(os.tmpdir(), 'test-ssh-config.json');

// Test 1: Load SSH credentials from file
async function testLoadCredentials() {
  console.log('Test 1: Load SSH credentials from file');
  
  const testConfig = {
    sshCredentials: [
      {
        name: 'test-server',
        host: 'test.example.com',
        port: 22,
        username: 'testuser',
        privateKeyPath: '~/.ssh/test_key',
        passphrase: '' // Empty passphrase for testing
      }
    ]
  };

  // Write test config to file
  await fs.writeFile(testConfigPath, JSON.stringify(testConfig, null, 2), 'utf8');
  
  // Load credentials from file
  await sshManager.loadCredentials(testConfigPath);
  
  assert(sshManager.hasCredentials(), 'SSH manager should have credentials loaded');
  
  console.log('✓ SSH credentials loaded successfully from file\n');
}

// Test 2: List SSH credentials
async function testListSSHCredentials() {
  console.log('Test 2: List SSH credentials');
  
  const credentials = sshManager.listCredentials();
  
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
  
  const testConfig = {
    sshCredentials: [
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
    ]
  };
  
  // Write new config
  await fs.writeFile(testConfigPath, JSON.stringify(testConfig, null, 2), 'utf8');
  
  // Reload credentials
  await sshManager.loadCredentials(testConfigPath);
  
  const credentials = sshManager.listCredentials();
  assert.equal(credentials.length, 2, 'Should have 2 credentials');
  assert.equal(credentials[0].name, 'server1', 'First credential name should match');
  assert.equal(credentials[1].name, 'server2', 'Second credential name should match');
  
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
  
  const validConfig = {
    sshCredentials: [
      {
        name: 'valid-server',
        host: 'valid.example.com',
        username: 'validuser',
        privateKeyPath: '/path/to/key'
      }
    ]
  };
  
  await fs.writeFile(testConfigPath, JSON.stringify(validConfig, null, 2), 'utf8');
  await sshManager.loadCredentials(testConfigPath);
  
  const credentials = sshManager.listCredentials();
  assert.equal(credentials.length, 1, 'Should have 1 credential');
  assert(credentials[0].name, 'Name is required');
  assert(credentials[0].host, 'Host is required');
  assert(credentials[0].username, 'Username is required');
  
  console.log('✓ Configuration validation working correctly\n');
}

// Test 6: Invalid config file handling
async function testInvalidConfigHandling() {
  console.log('Test 6: Invalid config file handling');
  
  // Test with non-existent file
  try {
    await sshManager.loadCredentials('/non/existent/path.json');
    assert.fail('Should have thrown an error for non-existent file');
  } catch (error) {
    assert(error.message.includes('not found'), 'Error should mention file not found');
    console.log('✓ Correctly handles non-existent config file');
  }
  
  // Test with invalid JSON
  const invalidJsonPath = path.join(os.tmpdir(), 'invalid-ssh-config.json');
  await fs.writeFile(invalidJsonPath, 'invalid json content', 'utf8');
  
  try {
    await sshManager.loadCredentials(invalidJsonPath);
    assert.fail('Should have thrown an error for invalid JSON');
  } catch (error) {
    assert(error.message.includes('Failed to load SSH config'), 'Error should mention config load failure');
    console.log('✓ Correctly handles invalid JSON\n');
  }
  
  // Cleanup
  await fs.unlink(invalidJsonPath).catch(() => {});
}

// Test 7: Cleanup
async function testCleanup() {
  console.log('Test 7: Cleanup');
  
  // Clean up test config file
  await fs.unlink(testConfigPath).catch(() => {});
  
  console.log('✓ Cleanup completed successfully\n');
}

// Run all tests
async function runTests() {
  try {
    await testLoadCredentials();
    await testListSSHCredentials();
    await testMultipleCredentials();
    await testSSHCommandErrorHandling();
    await testConfigurationValidation();
    await testInvalidConfigHandling();
    await testCleanup();
    
    console.log('✅ All SSH tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    // Cleanup on failure
    await fs.unlink(testConfigPath).catch(() => {});
    process.exit(1);
  }
}

runTests();
