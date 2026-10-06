/**
 * Automated test suite for Meeting Transcript Summarization Feature:
 * 1. Session start, speech logging, and session end
 * 2. LLMService meeting transcript summarization (with structured output)
 * 3. TranscriptLoggerManager summary persistence (_summary.md & inside .txt)
 * 4. Summary retrieval and listing metadata (hasSummary, summaryPath)
 * 5. Edge cases: empty transcript, short transcript, and offline fallback
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const transcriptLogger = require('../src/managers/transcript-logger.manager');
const llmService = require('../src/services/llm.service');

async function runTests() {
  console.log('\n=== Testing Meeting Transcript Summarization Feature ===\n');

  // Test 1: Start a session and log realistic meeting speech
  console.log('1. Starting meeting transcript session...');
  const filePath = transcriptLogger.startSession('interview');
  assert(filePath && fs.existsSync(filePath), 'Transcript file must be created');

  console.log('2. Logging meeting speech utterances...');
  transcriptLogger.logSpeech('Good morning everyone, welcome to our architectural review meeting.', 'SPEAKER');
  transcriptLogger.logSpeech('Today we need to decide on our database migration strategy and assign tasks for sprint 14.', 'SPEAKER');
  transcriptLogger.logSpeech('We agreed to proceed with PostgreSQL partitioning and schedule the maintenance window for Saturday.', 'SPEAKER');
  transcriptLogger.logSpeech('Action item: Carlos will write the migration script by Thursday.', 'SPEAKER');
  transcriptLogger.logAIResponse('PostgreSQL declarative partitioning provides optimal read throughput for time-series datasets.');

  const savedPath = transcriptLogger.endSession();
  assert.strictEqual(savedPath, filePath, 'endSession should return the active file path');
  assert.strictEqual(transcriptLogger.getLastSessionFilePath(), savedPath, 'getLastSessionFilePath should track ended session');
  console.log('  PASS: Meeting transcript session created and finalized:', path.basename(savedPath));

  // Test 2: Read transcript content
  console.log('3. Reading transcript content...');
  const transcriptContent = transcriptLogger.getTranscriptContent(savedPath);
  assert(transcriptContent && transcriptContent.includes('PostgreSQL partitioning'), 'Transcript should contain spoken content');
  console.log('  PASS: Transcript content read successfully (' + transcriptContent.length + ' chars)');

  // Test 3: LLMService summarization
  console.log('4. Generating meeting summary via LLMService...');
  const summary = await llmService.summarizeMeetingTranscript(transcriptContent);
  assert(typeof summary === 'string' && summary.trim().length > 50, 'Summary should be non-empty string');
  assert(summary.includes('Resumo') || summary.includes('Reunião'), 'Summary should contain title');
  console.log('  PASS: Meeting summary generated successfully. Preview:');
  console.log('  ' + summary.split('\n').slice(0, 5).join('\n  ') + ' ...');

  // Test 4: Save summary to disk
  console.log('5. Saving meeting summary via TranscriptLoggerManager...');
  const summaryPath = transcriptLogger.saveTranscriptSummary(savedPath, summary);
  assert(summaryPath && fs.existsSync(summaryPath), 'Summary file should exist on disk');
  assert(summaryPath.endsWith('_summary.md'), 'Summary file must have _summary.md extension');

  const savedSummaryContent = fs.readFileSync(summaryPath, 'utf8');
  assert.strictEqual(savedSummaryContent.trim(), summary.trim(), 'Saved summary content must match generated summary');

  // Verify transcript .txt also has the summary section
  const updatedTxtContent = fs.readFileSync(savedPath, 'utf8');
  assert(updatedTxtContent.includes('MEETING SUMMARY (RESUMO DA REUNIÃO)'), '.txt transcript file should include summary section');
  console.log('  PASS: Summary saved as markdown and embedded in transcript file');

  // Test 5: Retrieve summary
  console.log('6. Retrieving summary via getTranscriptSummary...');
  const retrievedSummary = transcriptLogger.getTranscriptSummary(savedPath);
  assert.strictEqual(retrievedSummary.trim(), summary.trim(), 'Retrieved summary must match saved summary');
  console.log('  PASS: getTranscriptSummary returned correct summary');

  // Test 6: Verify listTranscripts includes summary metadata
  console.log('7. Verifying listTranscripts summary flags...');
  const list = transcriptLogger.listTranscripts();
  const found = list.find(t => t.path === savedPath);
  assert(found, 'Created session should appear in listTranscripts');
  assert.strictEqual(found.hasSummary, true, 'hasSummary must be true');
  assert.strictEqual(found.summaryPath, summaryPath, 'summaryPath must match');
  console.log('  PASS: listTranscripts correctly reports summary metadata');

  // Test 7: Edge cases
  console.log('8. Testing edge cases (empty & short transcripts)...');
  const emptyRes = await llmService.summarizeMeetingTranscript('');
  assert(emptyRes.includes('Nenhuma transcrição'), 'Empty transcript should return warning');

  const shortRes = await llmService.summarizeMeetingTranscript('oi');
  assert(shortRes.includes('muito curta') || shortRes.includes('não contém falas'), 'Short transcript should return warning');

  // Test offline fallback generator directly
  const fallbackRes = llmService._generateExtractiveMeetingSummaryFallback(transcriptContent);
  assert(fallbackRes.includes('Resumo da Reunião'), 'Fallback must produce structured markdown');
  assert(fallbackRes.includes('Falas Registradas'), 'Fallback must list utterances');
  console.log('  PASS: Edge cases and offline fallback verified');

  // Cleanup test files
  try {
    fs.unlinkSync(savedPath);
    fs.unlinkSync(summaryPath);
  } catch (_) {}

  console.log('\n=== All Meeting Transcript Summary Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
