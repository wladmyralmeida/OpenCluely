const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function testTeleprompterFeature() {
  console.log('--- Testing Eye-Line Teleprompter (Notch View) Feature ---');

  // Test 1: Validate teleprompter.html structure and assets
  console.log('1. Checking teleprompter.html file and markup...');
  const teleprompterPath = path.join(__dirname, '..', 'teleprompter.html');
  assert.strictEqual(fs.existsSync(teleprompterPath), true, 'teleprompter.html must exist');
  const htmlContent = fs.readFileSync(teleprompterPath, 'utf8');

  assert.strictEqual(htmlContent.includes('id="prompterContainer"'), true, 'Must have prompterContainer');
  assert.strictEqual(htmlContent.includes('id="bulletDisplayArea"'), true, 'Must have bulletDisplayArea');
  assert.strictEqual(htmlContent.includes('id="autoPaceBtn"'), true, 'Must have autoPaceBtn');
  assert.strictEqual(htmlContent.includes('id="snapToNotchBtn"'), true, 'Must have snapToNotchBtn');
  assert.strictEqual(htmlContent.includes('id="closePrompterBtn"'), true, 'Must have closePrompterBtn');
  assert.strictEqual(htmlContent.includes('EYE-LINE NOTCH'), true, 'Must display EYE-LINE NOTCH title');
  console.log('  PASS: teleprompter.html markup contains all required UI components');

  // Test 2: Check window.manager.js configuration
  console.log('2. Checking window.manager.js configs and methods...');
  const windowManager = require('../src/managers/window.manager');
  assert.strictEqual(typeof windowManager.windowConfigs.teleprompter, 'object', 'teleprompter must be in windowConfigs');
  assert.strictEqual(windowManager.windowConfigs.teleprompter.file, 'teleprompter.html');
  assert.strictEqual(typeof windowManager.createTeleprompterWindow, 'function', 'createTeleprompterWindow must exist');
  assert.strictEqual(typeof windowManager.showTeleprompterWindow, 'function', 'showTeleprompterWindow must exist');
  assert.strictEqual(typeof windowManager.hideTeleprompterWindow, 'function', 'hideTeleprompterWindow must exist');
  assert.strictEqual(typeof windowManager.toggleTeleprompterWindow, 'function', 'toggleTeleprompterWindow must exist');
  assert.strictEqual(typeof windowManager.snapTeleprompterToCamera, 'function', 'snapTeleprompterToCamera must exist');
  assert.strictEqual(typeof windowManager.sendToTeleprompterWindow, 'function', 'sendToTeleprompterWindow must exist');
  console.log('  PASS: WindowManager includes all teleprompter methods and configuration');

  // Test 3: Check snapTeleprompterToCamera calculation
  console.log('3. Checking camera notch snap positioning...');
  let mockX = 0;
  let mockY = 0;
  const mockTeleprompterWin = {
    isDestroyed: () => false,
    getSize: () => [580, 110],
    setPosition: (x, y) => {
      mockX = x;
      mockY = y;
    }
  };
  const pos = windowManager.snapTeleprompterToCamera(mockTeleprompterWin);
  assert.strictEqual(typeof pos, 'object', 'Position should be returned');
  assert.strictEqual(typeof pos.x, 'number', 'Position X should be numeric');
  assert.strictEqual(typeof pos.y, 'number', 'Position Y should be numeric');
  assert.strictEqual(pos.x, mockX, 'Mock window X must match returned X');
  assert.strictEqual(pos.y, mockY, 'Mock window Y must match returned Y');
  console.log(`  PASS: Teleprompter snapped successfully to x: ${pos.x}, y: ${pos.y}`);

  // Test 4: Check event forwarding from TranscriptionController
  console.log('4. Checking event forwarding to teleprompter...');
  let capturedChannel = null;
  let capturedData = null;
  const mockWm = {
    getWindow: () => null,
    getVoiceResponseTarget: () => 'both',
    sendToTeleprompterWindow: (channel, data) => {
      capturedChannel = channel;
      capturedData = data;
    }
  };

  const TranscriptionController = require('../src/controllers/transcription.controller');
  const controller = new TranscriptionController({
    appController: {},
    windowManager: mockWm,
    speechService: { on: () => {} },
    sessionManager: {},
    llmService: {},
    captureService: {}
  });

  controller.sendToVoiceResponseWindows('smart-talking-points', {
    points: ['Gancho 1', 'Exemplo 2', 'Trade-off 3'],
    question: 'Como funciona o garbage collector?'
  });

  assert.strictEqual(capturedChannel, 'smart-talking-points', 'Channel must be forwarded');
  assert.strictEqual(capturedData.points.length, 3, 'Points must be forwarded');
  console.log('  PASS: Talking points forwarded cleanly to teleprompter window');

  // Test 5: Check preload.js exposed methods
  console.log('5. Checking preload.js API exposure...');
  const preloadContent = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.strictEqual(preloadContent.includes('toggleTeleprompter:'), true, 'Must expose toggleTeleprompter');
  assert.strictEqual(preloadContent.includes('showTeleprompter:'), true, 'Must expose showTeleprompter');
  assert.strictEqual(preloadContent.includes('hideTeleprompter:'), true, 'Must expose hideTeleprompter');
  assert.strictEqual(preloadContent.includes('snapTeleprompterToCamera:'), true, 'Must expose snapTeleprompterToCamera');
  assert.strictEqual(preloadContent.includes('setTeleprompterContent:'), true, 'Must expose setTeleprompterContent');
  assert.strictEqual(preloadContent.includes('onTeleprompterData:'), true, 'Must expose onTeleprompterData');
  console.log('  PASS: preload.js includes all required Teleprompter APIs');

  // Test 6: Check index.html and chat.html buttons
  console.log('6. Checking index.html and chat.html UI buttons...');
  const indexContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chatContent = fs.readFileSync(path.join(__dirname, '..', 'chat.html'), 'utf8');
  assert.strictEqual(indexContent.includes('id="teleprompterButton"'), true, 'index.html must have teleprompterButton');
  assert.strictEqual(chatContent.includes('id="teleprompterToggleBtn"'), true, 'chat.html must have teleprompterToggleBtn');
  assert.strictEqual(chatContent.includes('Ver no Notch'), true, 'chat.html must have action to send to Notch');
  assert.strictEqual(chatContent.includes('/prompter'), true, 'chat.html must support /prompter slash command');
  console.log('  PASS: index.html and chat.html UI buttons and slash commands present');

  console.log('\n=== All Eye-Line Teleprompter Tests Passed Successfully! ===\n');
}

testTeleprompterFeature().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
