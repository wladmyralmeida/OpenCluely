/**
 * Tests for Call Transcript File Auto-Save Feature:
 * 1. Session start & file creation with header
 * 2. Speech and AI response real-time logging
 * 3. Session end & summary stats footer
 * 4. List and read transcript files
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const transcriptLogger = require('../src/managers/transcript-logger.manager');

async function runTests() {
  console.log('\n=== Call Transcript Auto-Save Feature Tests ===\n');

  // Test 1: Start session
  console.log('1. Starting transcript session...');
  const filePath = transcriptLogger.startSession('interview');
  assert(filePath && typeof filePath === 'string', 'Should return a valid file path');
  assert(fs.existsSync(filePath), `Transcript file ${filePath} should exist on disk`);

  const initialContent = fs.readFileSync(filePath, 'utf8');
  assert(initialContent.includes('OpenCluely - Call Transcript'), 'File should contain header');
  assert(initialContent.includes('Mode / Skill: INTERVIEW'), 'File should state skill');
  console.log('  PASS: Session started with header at:', filePath);

  // Test 2: Log spoken speech
  console.log('2. Logging spoken speech...');
  transcriptLogger.logSpeech('Can you explain Dijkstra algorithm and its complexity?', 'SPEAKER');
  transcriptLogger.logSpeech('Yes, Dijkstra uses a priority queue.', 'SPEAKER');

  const contentAfterSpeech = fs.readFileSync(filePath, 'utf8');
  assert(contentAfterSpeech.includes('[SPEAKER] Can you explain Dijkstra algorithm and its complexity?'), 'File should contain first spoken line');
  assert(contentAfterSpeech.includes('[SPEAKER] Yes, Dijkstra uses a priority queue.'), 'File should contain second spoken line');
  console.log('  PASS: Spoken utterances logged in real time');

  // Test 3: Log AI response
  console.log('3. Logging AI response...');
  transcriptLogger.logAIResponse('Dijkstra algorithm computes shortest paths from a single source with O((V + E) log V) time complexity.');

  const contentAfterAI = fs.readFileSync(filePath, 'utf8');
  assert(contentAfterAI.includes('[AI ASSISTANT]'), 'File should contain AI Assistant section');
  assert(contentAfterAI.includes('Dijkstra algorithm computes shortest paths'), 'File should contain AI response');
  console.log('  PASS: AI response logged to transcript');

  // Test 4: End session
  console.log('4. Ending transcript session...');
  const savedPath = transcriptLogger.endSession();
  assert.strictEqual(savedPath, filePath);
  assert.strictEqual(transcriptLogger.getCurrentFilePath(), null);

  const finalContent = fs.readFileSync(savedPath, 'utf8');
  assert(finalContent.includes('Session Ended:'), 'File should contain session end footer');
  assert(finalContent.includes('Total Utterances Logged: 2'), 'Footer should count utterances');
  assert(finalContent.includes('Total Words Spoken:'), 'Footer should count words');
  console.log('  PASS: Session finalized with summary footer');

  // Test 5: List transcripts
  console.log('5. Testing listTranscripts and getTranscriptContent...');
  const list = transcriptLogger.listTranscripts();
  assert(Array.isArray(list) && list.length > 0, 'Should list at least 1 transcript file');
  const found = list.find(t => t.path === savedPath);
  assert(found, 'Created transcript should be in list');

  const readContent = transcriptLogger.getTranscriptContent(path.basename(savedPath));
  assert.strictEqual(readContent, finalContent, 'getTranscriptContent should return full file content');
  console.log(`  PASS: Listed ${list.length} transcript(s) and verified content`);

  // Cleanup test file
  try {
    fs.unlinkSync(savedPath);
  } catch (_) {}

  console.log('\n=== All Call Transcript Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
