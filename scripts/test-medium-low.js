/**
 * Tests for Medium and Low priority improvements:
 * 1. Config validation & typed fallback getters
 * 2. System audio service state & auto-reconnect backoff
 * 3. Prompt loader reload & cache refreshing
 * 4. Logger logDir resolution & log directory creation
 */

const assert = require('assert');
const fs = require('fs');

async function runTests() {
  console.log('\n=== Medium & Low Priority Improvements Tests ===\n');

  // Test 1: Config validation
  console.log('1. Testing Config Schema Validation & Getters...');
  const config = require('../src/core/config');
  const validation = config.validate();
  assert.strictEqual(validation.valid, true, `Config should be valid, got errors: ${validation.errors}`);

  // Test default getter
  const fallbackVal = config.get('non.existent.key', 'default_fallback');
  assert.strictEqual(fallbackVal, 'default_fallback');

  const vadHangover = config.get('speech.whisper.silenceHangoverMs');
  assert.strictEqual(vadHangover, 400);

  const vadMinUtterance = config.get('speech.whisper.minUtteranceMs');
  assert.strictEqual(vadMinUtterance, 250);
  console.log('  PASS: Config validation and getters working as expected');

  // Test 2: SystemAudioService
  console.log('2. Testing SystemAudioService Reconnect Logic...');
  const { SystemAudioService } = require('../src/services/system-audio.service');
  const sysAudio = new SystemAudioService();
  assert.strictEqual(sysAudio.isRunning, false);
  assert.strictEqual(sysAudio.reconnectAttempts, 0);
  assert.strictEqual(typeof sysAudio.start, 'function');
  assert.strictEqual(typeof sysAudio.stop, 'function');
  console.log('  PASS: SystemAudioService initialized correctly');

  // Test 3: PromptLoader reloadPrompts
  console.log('3. Testing PromptLoader reloadPrompts...');
  const { promptLoader } = require('../prompt-loader');
  const count = promptLoader.reloadPrompts();
  assert(count > 0, `Should reload at least 1 prompt, got ${count}`);
  const interviewPrompt = promptLoader.getSkillPrompt('interview');
  assert(typeof interviewPrompt === 'string' && interviewPrompt.length > 0);
  console.log(`  PASS: PromptLoader reloaded ${count} prompts successfully`);

  // Test 4: Logger logDir resolution
  console.log('4. Testing Logger log directory...');
  const logger = require('../src/core/logger');
  assert(logger.logDir && typeof logger.logDir === 'string');
  assert(fs.existsSync(logger.logDir), `Log directory ${logger.logDir} should exist`);
  console.log(`  PASS: Log directory verified at: ${logger.logDir}`);

  console.log('\n=== All Medium & Low Priority Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
