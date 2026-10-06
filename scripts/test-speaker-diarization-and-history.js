/**
 * Automated test suite for:
 * 1. 🎙️ Identificação de Locutores por Canal de Áudio (Speaker Diarization)
 *    - Channel source routing ('mic' vs 'system')
 *    - Speaker tag resolution ('VOCÊ' vs 'ENTREVISTADOR')
 *    - Multi-speaker transcript formatting
 * 2. 📚 Gerenciador Visual de Reuniões Passadas (Histórico, Busca e Ações)
 *    - Transcript metadata extraction (duration, wordCount, utteranceCount, speakers, preview)
 *    - Enriched transcript listing in ~/.OpenCluely/transcripts/
 *    - Transcript deletion (unlinks both .txt and _summary.md)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const transcriptLogger = require('../src/managers/transcript-logger.manager');
const TranscriptionController = require('../src/controllers/transcription.controller');

async function runTests() {
  console.log('\n=== Testing Speaker Diarization & Meeting History Manager ===\n');

  // Test 1: Speaker Diarization resolution in TranscriptionController
  console.log('1. Testing Speaker Diarization resolution...');
  const controller = new TranscriptionController({
    llmService: {},
    sessionManager: { addUserInput: () => {}, getOptimizedHistory: () => ({ recent: [] }) },
    windowManager: {},
    speechService: { isManualCaptureMode: () => false },
    activeSkill: 'interview'
  });

  assert.strictEqual(controller._resolveSpeaker('mic'), 'VOCÊ', 'mic source should map to VOCÊ');
  assert.strictEqual(controller._resolveSpeaker('system'), 'ENTREVISTADOR', 'system loopback should map to ENTREVISTADOR');
  assert.strictEqual(controller._resolveSpeaker('loopback'), 'ENTREVISTADOR', 'loopback should map to ENTREVISTADOR');
  assert.strictEqual(controller._resolveSpeaker('VOCÊ'), 'VOCÊ', 'VOCÊ should be preserved');
  assert.strictEqual(controller._resolveSpeaker('ENTREVISTADOR'), 'ENTREVISTADOR', 'ENTREVISTADOR should be preserved');
  assert.strictEqual(controller._resolveSpeaker(null), 'VOCÊ', 'null default should be VOCÊ');
  console.log('  PASS: Speaker resolution correctly tags mic -> VOCÊ and system -> ENTREVISTADOR');

  // Test 2: Start a simulated interview session with both speakers
  console.log('2. Starting simulated interview session with two speakers...');
  const filePath = transcriptLogger.startSession('interview');
  assert(filePath && fs.existsSync(filePath), 'Transcript file should be created');

  transcriptLogger.logSpeech('Olá! Pode nos contar sobre sua experiência com microsserviços e mensageria?', 'ENTREVISTADOR');
  transcriptLogger.logSpeech('Com certeza! Trabalhei 4 anos desenhando arquiteturas orientadas a eventos com Apache Kafka e RabbitMQ.', 'VOCÊ');
  transcriptLogger.logSpeech('Como você lidava com ordenação de eventos e idempotência de consumidores?', 'ENTREVISTADOR');
  transcriptLogger.logSpeech('Utilizávamos correlation IDs com partition keys baseadas no ID da entidade e tabelas de deduplicação no PostgreSQL.', 'VOCÊ');
  transcriptLogger.logSpeech('Excelente resposta. Vamos para uma questão de algoritmos agora.', 'ENTREVISTADOR');

  const endedPath = transcriptLogger.endSession();
  assert.strictEqual(endedPath, filePath, 'Session should finalize current file');
  console.log('  PASS: Multi-turn interview session recorded at', path.basename(endedPath));

  // Test 3: Verify content has exact speaker tags
  console.log('3. Verifying speaker tags in transcript content...');
  const content = transcriptLogger.getTranscriptContent(endedPath);
  assert(content.includes('[ENTREVISTADOR] Olá! Pode nos contar'), 'Transcript must contain [ENTREVISTADOR]');
  assert(content.includes('[VOCÊ] Com certeza! Trabalhei'), 'Transcript must contain [VOCÊ]');
  console.log('  PASS: Transcript contains verified [ENTREVISTADOR] and [VOCÊ] turns');

  // Test 4: Verify metadata extraction
  console.log('4. Testing _extractTranscriptMetadata...');
  const meta = transcriptLogger._extractTranscriptMetadata(content);
  assert(Array.isArray(meta.speakers), 'Metadata should include speakers list');
  assert(meta.speakers.includes('VOCÊ'), 'Speakers should include VOCÊ');
  assert(meta.speakers.includes('ENTREVISTADOR'), 'Speakers should include ENTREVISTADOR');
  assert(meta.utteranceCount >= 5, `Utterance count should be >= 5, got ${meta.utteranceCount}`);
  assert(meta.wordCount > 20, `Word count should be > 20, got ${meta.wordCount}`);
  assert(meta.preview && meta.preview.length > 10, 'Preview should be extracted');
  console.log('  PASS: Metadata extracted:', {
    speakers: meta.speakers,
    utterances: meta.utteranceCount,
    words: meta.wordCount,
    preview: meta.preview.substring(0, 60) + '...'
  });

  // Test 5: Verify listTranscripts returns enriched data
  console.log('5. Testing listTranscripts with rich metadata...');
  // Also create a mock summary file to test hasSummary flag
  const summaryPath = endedPath.replace(/\.txt$/, '_summary.md');
  fs.writeFileSync(summaryPath, '# Resumo Executivo da Entrevista\n\nCandidato demonstrou forte domínio em Kafka e PostgreSQL.', 'utf8');

  const list = transcriptLogger.listTranscripts();
  const currentItem = list.find(item => item.name === path.basename(endedPath));
  assert(currentItem, 'Current transcript must appear in list');
  assert.strictEqual(currentItem.hasSummary, true, 'hasSummary must be true');
  assert(currentItem.summaryPreview && currentItem.summaryPreview.includes('Candidato demonstrou'), 'summaryPreview must contain summary snippet');
  assert(currentItem.speakers.includes('VOCÊ') && currentItem.speakers.includes('ENTREVISTADOR'), 'list item must have speakers');
  console.log('  PASS: listTranscripts() returns rich card metadata for GUI');

  // Test 6: Verify deleteTranscript unlinks both transcript and summary
  console.log('6. Testing deleteTranscript...');
  assert(fs.existsSync(endedPath), 'Transcript should exist before delete');
  assert(fs.existsSync(summaryPath), 'Summary should exist before delete');

  const deleteResult = transcriptLogger.deleteTranscript(path.basename(endedPath));
  assert(deleteResult.success, 'deleteTranscript should return success');
  assert(!fs.existsSync(endedPath), 'Transcript .txt should be deleted');
  assert(!fs.existsSync(summaryPath), 'Summary _summary.md should be deleted');
  console.log('  PASS: deleteTranscript cleanly unlinked both files');

  console.log('\n=== All Speaker Diarization & History Manager Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
