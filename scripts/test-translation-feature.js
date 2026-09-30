const assert = require('assert');
const TranscriptionController = require('../src/controllers/transcription.controller');
const llmService = require('../src/services/llm.service');

async function testTranslationFeature() {
  console.log('--- Testing Bilingual Transcription Translation Feature ---');

  let capturedData = null;
  const mockChatWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, data) => {
        if (channel === 'transcription-received') {
          capturedData = data;
        }
      }
    }
  };

  const mockWindowManager = {
    getWindow: (name) => (name === 'chat' ? mockChatWindow : null),
    broadcastToAllWindows: (channel, data) => {}
  };

  const mockSpeechService = {
    on: () => {},
    isCurrentlyListening: () => false,
    isManualCaptureMode: () => false
  };

  const mockSessionManager = {
    addTranscriptionFragment: () => {},
    addUserInput: () => {},
    addUserMessage: () => {},
    addModelResponse: () => {},
    getFormattedHistory: () => ({ recent: [] })
  };

  const transcriptionController = new TranscriptionController({
    appController: {},
    windowManager: mockWindowManager,
    speechService: mockSpeechService,
    sessionManager: mockSessionManager,
    llmService,
    captureService: {}
  });

  // Test 1: Translation toggle
  assert.strictEqual(typeof transcriptionController.setTranslationEnabled, 'function', 'setTranslationEnabled should be a function');
  assert.strictEqual(typeof transcriptionController.isTranslationEnabled, 'function', 'isTranslationEnabled should be a function');

  transcriptionController.setTranslationEnabled(true);
  assert.strictEqual(transcriptionController.isTranslationEnabled(), true, 'Translation should be enabled');

  transcriptionController.setTranslationEnabled(false);
  assert.strictEqual(transcriptionController.isTranslationEnabled(), false, 'Translation should be disabled');

  // Test 2: LLM Translation Service method
  assert.strictEqual(typeof llmService.translateToPortuguese, 'function', 'translateToPortuguese should be a function');

  const emptyRes = await llmService.translateToPortuguese('');
  assert.strictEqual(emptyRes, '', 'Empty string translation should return empty string');

  // Test 3: Flow with Translation Disabled
  transcriptionController.setTranslationEnabled(false);
  capturedData = null;

  await transcriptionController.handleTranscriptionFragment('Hello world, this is a test.');
  assert.ok(capturedData, 'Should receive transcription data');
  assert.strictEqual(capturedData.text, 'Hello world, this is a test.');
  assert.strictEqual(capturedData.translationPT, null, 'translationPT should be null when disabled');

  // Test 4: Flow with Translation Enabled (with mocked translateToPortuguese for fast unit test)
  const origTranslate = llmService.translateToPortuguese;
  llmService.translateToPortuguese = async (text) => `Olá mundo, isso é um teste. (${text})`;

  transcriptionController.setTranslationEnabled(true);
  capturedData = null;

  await transcriptionController.handleTranscriptionFragment('Hello world, this is a test.');
  assert.ok(capturedData, 'Should receive transcription data');
  assert.strictEqual(capturedData.text, 'Hello world, this is a test.');
  assert.strictEqual(capturedData.translationPT, 'Olá mundo, isso é um teste. (Hello world, this is a test.)');

  // Restore
  llmService.translateToPortuguese = origTranslate;
  transcriptionController.setTranslationEnabled(false);

  console.log('✅ All bilingual translation tests passed successfully!');
}

testTranslationFeature().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
