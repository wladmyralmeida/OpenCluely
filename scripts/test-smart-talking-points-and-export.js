/**
 * Automated test suite for:
 * 1. 🚀 Smart Talking Points (Predictive 3-point quick responses)
 * 2. 📤 1-Click Meeting Exporter (PDF, Notion/Slack, Checklist)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const transcriptLogger = require('../src/managers/transcript-logger.manager');
const llmService = require('../src/services/llm.service');
const TranscriptionController = require('../src/controllers/transcription.controller');

async function runTests() {
  console.log('\n=== Testing Smart Talking Points & 1-Click Meeting Exporter ===\n');

  // Test 1: Smart Talking Points generation
  console.log('1. Testing Smart Talking Points generation via LLMService...');
  const tpResult = await llmService.generateSmartTalkingPoints(
    'Como você desenha uma arquitetura de microsserviços com Apache Kafka garantindo ordenação e tolerância a falhas?',
    'interview'
  );

  assert(tpResult && Array.isArray(tpResult.points), 'Result must contain points array');
  assert.strictEqual(tpResult.points.length, 3, 'Must return exactly 3 strategic talking points');
  assert(tpResult.points.some(p => p.toLowerCase().includes('kafka') || p.toLowerCase().includes('parti') || p.toLowerCase().includes('desacop')), 'Points should be contextually relevant');
  console.log('  PASS: Generated 3 Smart Talking Points:');
  tpResult.points.forEach((p, idx) => console.log(`    ${idx + 1}. ${p}`));

  // Test 2: Smart Talking Points in TranscriptionController
  console.log('2. Testing Smart Talking Points through TranscriptionController...');
  const controller = new TranscriptionController({
    llmService,
    sessionManager: { addUserInput: () => {}, getOptimizedHistory: () => ({ recent: [] }) },
    windowManager: {},
    speechService: { isManualCaptureMode: () => false },
    activeSkill: 'interview'
  });

  const controllerTp = await controller.generateSmartTalkingPoints('Como otimizar consultas lentas no PostgreSQL?');
  assert(controllerTp && Array.isArray(controllerTp.points) && controllerTp.points.length === 3, 'Controller must provide 3 points');
  console.log('  PASS: Controller smart talking points generated successfully');

  // Test 3: Action Items Extraction
  console.log('3. Testing Action Items extraction from meeting summary and transcript...');
  const sampleSummary = `
# 📋 Resumo Executivo da Reunião
## 🎯 Visão Geral
Alinhamento técnico sobre infraestrutura e banco de dados.

## 🚀 Próximos Passos & Ações
- [ ] Criar índices parciais na tabela de transações
- [ ] Configurar réplica de leitura para relatórios
- [ ] Carlos irá preparar o script de migração até sexta-feira
`;

  const sampleTranscript = `
[10:00:00] [ENTREVISTADOR] Qual é a próxima prioridade do time?
[10:00:05] [VOCÊ] Ficou combinado: testar o cluster Kubernetes em staging antes do deploy.
`;

  const actionResult = transcriptLogger.extractActionItems(sampleSummary, sampleTranscript);
  assert(actionResult && Array.isArray(actionResult.items), 'Action result must return items');
  assert(actionResult.items.length >= 3, 'Should extract at least 3 action items');
  assert(actionResult.checklistMarkdown.includes('- [ ] Criar índices'), 'Checklist markdown must have checkbox syntax');
  console.log('  PASS: Extracted action items checklist:');
  actionResult.items.forEach(it => console.log(`    - [ ] ${it}`));

  // Test 4: Notion / Slack template generation
  console.log('4. Testing Notion/Slack Markdown template generation...');
  const sessionPath = transcriptLogger.startSession('interview');
  transcriptLogger.logSpeech('Bom dia! Vamos começar a revisão de arquitetura.', 'ENTREVISTADOR');
  transcriptLogger.logSpeech('Combinado: migrar o banco para PostgreSQL e particionar por data.', 'VOCÊ');
  transcriptLogger.logSpeech('Action item: Julia revisará o pull request até amanhã.', 'ENTREVISTADOR');
  const savedSession = transcriptLogger.endSession();

  const notionTemplate = transcriptLogger.generateNotionSlackTemplate(savedSession);
  assert(typeof notionTemplate === 'string' && notionTemplate.length > 50, 'Template should be non-empty string');
  assert(notionTemplate.includes('# 📋 Ata de Reunião') || notionTemplate.includes('Ata:'), 'Template must have title');
  assert(notionTemplate.includes('## ✅ Checklist de Ações'), 'Template must include Action Items Checklist');
  assert(notionTemplate.includes('- [ ]'), 'Template must include interactive markdown checkboxes');
  assert(notionTemplate.includes('OpenCluely'), 'Template must have footer branding');
  console.log('  PASS: Notion/Slack template generated. Preview:');
  console.log('  ' + notionTemplate.split('\n').slice(0, 8).join('\n  ') + ' ...');

  // Test 5: Executive HTML Report generation (for PDF rendering)
  console.log('5. Testing Executive HTML Report generation...');
  const htmlReport = transcriptLogger.generateExecutiveHtmlReport(savedSession);
  assert(typeof htmlReport === 'string' && htmlReport.includes('<!DOCTYPE html>'), 'HTML report must be valid HTML');
  assert(htmlReport.includes('OpenCluely • Executive Report'), 'HTML report must contain header branding');
  assert(htmlReport.includes('checklist-item'), 'HTML report must contain styled checklist');
  assert(htmlReport.includes('turn-speaker') && htmlReport.includes('badge-user'), 'HTML report must contain dialogue badges');
  assert(htmlReport.includes('@media print'), 'HTML report must be print/PDF styled');
  console.log('  PASS: Executive HTML Report successfully generated (' + htmlReport.length + ' chars)');

  // Clean up test file
  transcriptLogger.deleteTranscript(savedSession);

  console.log('\n=== All Smart Talking Points & Exporter Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
