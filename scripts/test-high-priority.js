/**
 * Smoke tests for High Priority architectural improvements:
 * 1. LLM error analysis & retry delay computation
 * 2. SessionManager persistence to disk & reload
 * 3. Controllers instantiation & routing
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('\n=== High Priority Architectural Improvements Tests ===\n');

  // Test 1: LLM Retry & Error Classification
  console.log('1. Testing LLM Error Analysis & Backoff...');
  const llmService = require('../src/services/llm.service');

  const rateLimitErr = llmService.analyzeError(new Error('Resource has been exhausted (e.g. check quota) - 429'));
  assert.strictEqual(rateLimitErr.type, 'RATE_LIMIT_ERROR');
  assert.strictEqual(rateLimitErr.isRetryable, true);

  const serverErr = llmService.analyzeError(new Error('503 Service Unavailable: The model is overloaded'));
  assert.strictEqual(serverErr.type, 'SERVER_ERROR');
  assert.strictEqual(serverErr.isRetryable, true);

  const authErr = llmService.analyzeError(new Error('API_KEY_INVALID: API key not valid'));
  assert.strictEqual(authErr.type, 'AUTH_ERROR');
  assert.strictEqual(authErr.isRetryable, false);

  const netErr = llmService.analyzeError(new Error('fetch failed: ECONNRESET'));
  assert.strictEqual(netErr.type, 'NETWORK_ERROR');
  assert.strictEqual(netErr.isRetryable, true);

  // Test backoff calculation
  const delay1 = llmService._computeRetryDelay(1, 500, 4000);
  const delay2 = llmService._computeRetryDelay(2, 500, 4000);
  const delay3 = llmService._computeRetryDelay(3, 500, 4000);
  assert(delay1 >= 500 && delay1 <= 750, `Delay 1 should be around 500ms, got ${delay1}`);
  assert(delay2 >= 1000 && delay2 <= 1250, `Delay 2 should be around 1000ms, got ${delay2}`);
  assert(delay3 >= 2000 && delay3 <= 2250, `Delay 3 should be around 2000ms, got ${delay3}`);
  console.log('  PASS: LLM error classification & exponential backoff');

  // Test 2: SessionManager Persistence
  console.log('2. Testing SessionManager Disk Persistence...');
  const sessionManager = require('../src/managers/session.manager');
  sessionManager.clear();

  sessionManager.addUserInput('Test user message for persistence', 'chat');
  sessionManager.addModelResponse('Test model reply for persistence', { test: true });

  // Force synchronous disk write for test
  sessionManager._saveToDisk();

  const storagePath = sessionManager._getStoragePath();
  assert(fs.existsSync(storagePath), `Session memory file should exist at ${storagePath}`);

  const raw = fs.readFileSync(storagePath, 'utf8');
  const data = JSON.parse(raw);
  assert(Array.isArray(data), 'Saved data should be an array');
  assert(data.length >= 2, `Saved data should have at least 2 events, got ${data.length}`);

  // Test clear deletes storage
  sessionManager.clear();
  assert(!fs.existsSync(storagePath), 'Session memory file should be removed on clear()');
  console.log('  PASS: SessionManager disk persistence & clear');

  // Test 3: Controllers Loading & Delegation
  console.log('3. Testing Controllers Modularization...');
  const ShortcutController = require('../src/controllers/shortcut.controller');
  const TranscriptionController = require('../src/controllers/transcription.controller');

  assert(typeof ShortcutController === 'function');
  assert(typeof TranscriptionController === 'function');

  const tc = new TranscriptionController({
    appController: { activeSkill: 'interview', codingLanguage: 'cpp', _speechModeGeneration: 1 },
    windowManager: {},
    speechService: { isManualCaptureMode: () => false },
    sessionManager,
    llmService,
    captureService: {}
  });

  assert.strictEqual(tc.activeSkill, 'interview');
  assert.strictEqual(tc.codingLanguage, 'cpp');
  assert.strictEqual(tc.utteranceBuffer, '');
  console.log('  PASS: Controllers correctly instantiate and bind state');

  console.log('\n=== All High Priority Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
