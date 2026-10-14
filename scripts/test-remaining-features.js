/**
 * Automated Verification Script for OpenCluely Remaining Prioritized Features:
 * 1. 🚨 Boss Key (Modo Pânico Instantâneo)
 * 2. 🛡️ Modo Zero-Touch (Detecção Automática de Perguntas)
 * 3. 🎯 Central de Conhecimento do Candidato (RAG & Cases STAR)
 * 4. 💻 Live Code Sentinel & Corner Case Watcher
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('🚀 Starting Verification for Remaining Prioritized Features...\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
  }
}

async function run() {
  // ==========================================
  // 1. BOSS KEY / MODO PÂNICO
  // ==========================================
  console.log('--- 1. Testing Boss Key (Modo Pânico Instantâneo) ---');

  const windowManager = require('../src/managers/window.manager');

  // Mock windows with webContents.send
  let win1Visible = true;
  let win2Visible = true;
  const mockChatWin = {
    isDestroyed: () => false,
    isVisible: () => win1Visible,
    hide: () => { win1Visible = false; },
    show: () => { win1Visible = true; },
    focus: () => {},
    webContents: { send: () => {} }
  };
  const mockTeleprompterWin = {
    isDestroyed: () => false,
    isVisible: () => win2Visible,
    hide: () => { win2Visible = false; },
    show: () => { win2Visible = true; },
    focus: () => {},
    webContents: { send: () => {} }
  };

  windowManager.windows.set('chat', mockChatWin);
  windowManager.windows.set('teleprompter', mockTeleprompterWin);

  test('Boss Key initially inactive', () => {
    assert.strictEqual(windowManager.isBossKeyActive, false);
  });

  test('triggerBossKey hides all visible windows and tracks state', () => {
    const isHidden = windowManager.triggerBossKey();
    assert.strictEqual(isHidden, true);
    assert.strictEqual(windowManager.isBossKeyActive, true);
    assert.strictEqual(win1Visible, false);
    assert.strictEqual(win2Visible, false);
  });

  test('restoreFromBossKey restores previously visible windows', () => {
    const isRestored = windowManager.restoreFromBossKey();
    assert.strictEqual(isRestored, false);
    assert.strictEqual(windowManager.isBossKeyActive, false);
    assert.strictEqual(win1Visible, true);
    assert.strictEqual(win2Visible, true);
  });

  test('toggleBossKey flips state back and forth cleanly', () => {
    windowManager.toggleBossKey();
    assert.strictEqual(windowManager.isBossKeyActive, true);
    assert.strictEqual(win1Visible, false);

    windowManager.toggleBossKey();
    assert.strictEqual(windowManager.isBossKeyActive, false);
    assert.strictEqual(win1Visible, true);
  });

  // ==========================================
  // 2. MODO ZERO-TOUCH
  // ==========================================
  console.log('\n--- 2. Testing Modo Zero-Touch (Proactive Question Detection) ---');

  const TranscriptionController = require('../src/controllers/transcription.controller');
  const tc = new TranscriptionController({
    appController: {},
    windowManager,
    speechService: {},
    sessionManager: {},
    llmService: {}
  });

  test('Zero-Touch config toggling', () => {
    assert.strictEqual(typeof tc.isZeroTouchEnabled(), 'boolean');
    tc.setZeroTouchEnabled(true);
    assert.strictEqual(tc.isZeroTouchEnabled(), true);
    tc.setZeroTouchEnabled(false);
    assert.strictEqual(tc.isZeroTouchEnabled(), false);
    tc.setZeroTouchEnabled(true);
  });

  test('isQuestionUtterance identifies interrogative questions in Portuguese', () => {
    const ptQuestions = [
      "Como você resolveria um problema de concorrência no banco de dados?",
      "Qual foi o projeto mais desafiador da sua carreira?",
      "Você poderia explicar a diferença entre processo e thread?",
      "Por que você escolheu utilizar Redis em vez de Memcached?",
      "O que você faria se a fila do Kafka começasse a acumular mensagens?",
      "Me conte sobre uma vez que você precisou lidar com um conflito técnico.",
      "Fale sobre como você desenharia uma arquitetura de microsserviços."
    ];

    for (const q of ptQuestions) {
      assert.strictEqual(tc.isQuestionUtterance(q), true, `Expected true for: "${q}"`);
    }
  });

  test('isQuestionUtterance identifies questions in English', () => {
    const enQuestions = [
      "How would you design a scalable distributed cache?",
      "Could you explain the difference between TCP and UDP?",
      "What is your approach to handling database deadlocks?",
      "Why did you choose PostgreSQL over MongoDB for that service?",
      "Tell me about a time you had to deal with an outage."
    ];

    for (const q of enQuestions) {
      assert.strictEqual(tc.isQuestionUtterance(q), true, `Expected true for: "${q}"`);
    }
  });

  test('isQuestionUtterance ignores non-questions / declarative statements', () => {
    const statements = [
      "Perfeito, vamos continuar a entrevista agora.",
      "Entendi o seu ponto de vista.",
      "Muito obrigado pelo seu tempo hoje.",
      "Sim, com certeza."
    ];

    for (const s of statements) {
      assert.strictEqual(tc.isQuestionUtterance(s), false, `Expected false for statement: "${s}"`);
    }
  });

  // ==========================================
  // 3. CANDIDATE KNOWLEDGE RAG (MÉTODO STAR)
  // ==========================================
  console.log('\n--- 3. Testing Candidate Knowledge Base (RAG & STAR Cases) ---');

  const knowledgeRagManager = require('../src/managers/knowledge-rag.manager');

  test('knowledgeRagManager loads default cases out of the box', () => {
    const cases = knowledgeRagManager.getAllItems();
    assert.ok(Array.isArray(cases));
    assert.ok(cases.length >= 3, `Expected at least 3 seeded cases, got ${cases.length}`);
  });

  test('knowledgeRagManager retrieves relevant cases via BM25 matching', () => {
    const query = "Conte sobre uma vez que você enfrentou problemas de lentidão ou latência em pagamentos";
    const relevant = knowledgeRagManager.findRelevantCases(query, 2);
    assert.ok(relevant.length > 0);
    assert.ok(
      relevant.some(c => c.tags.includes('latência') || c.tags.includes('microsserviços') || c.tags.includes('redis')),
      'Should retrieve latency / architecture case'
    );
  });

  test('knowledgeRagManager formats prompt injection correctly with STAR method', () => {
    const query = "Como você lidou com um incidente crítico em produção?";
    const injection = knowledgeRagManager.formatPromptInjection(query);
    assert.ok(injection.toUpperCase().includes('STAR'), 'Should include STAR method instructions');
    assert.ok(injection.toUpperCase().includes('SITUAÇÃO'), 'Should include SITUAÇÃO section');
    assert.ok(injection.toUpperCase().includes('AÇÃO'), 'Should include AÇÃO section');
    assert.ok(injection.toUpperCase().includes('RESULTADO'), 'Should include RESULTADO section');
  });

  test('knowledgeRagManager CRUD operations (save and delete case)', () => {
    const initialCount = knowledgeRagManager.getAllItems().length;
    const newCase = knowledgeRagManager.saveItem({
      title: 'Teste Automatizado de Migração Cloud',
      role: 'Staff Engineer',
      situation: 'Servidor legado on-premise sem redundância',
      task: 'Migrar 40 instâncias para AWS com zero indisponibilidade',
      action: 'Criei pipeline Terraform e deploy canário no Kubernetes',
      result: '99.99% SLA atingido e economia de 35% no custo anual',
      keywords: ['terraform', 'aws', 'kubernetes', 'migração']
    });

    assert.ok(newCase.id);
    assert.strictEqual(knowledgeRagManager.getAllItems().length, initialCount + 1);

    // Verify retrieval of newly created case
    const match = knowledgeRagManager.findRelevantCases('Como foi a migração para Kubernetes e AWS?', 1);
    assert.strictEqual(match[0].id, newCase.id);

    // Delete case
    const deleted = knowledgeRagManager.deleteItem(newCase.id);
    assert.strictEqual(deleted, true);
    assert.strictEqual(knowledgeRagManager.getAllItems().length, initialCount);
  });

  // ==========================================
  // 4. LIVE CODE SENTINEL & CORNER CASE WATCHER
  // ==========================================
  console.log('\n--- 4. Testing Live Code Sentinel & Corner Case Watcher ---');

  const llmService = require('../src/services/llm.service');

  await asyncTest('llmService.analyzeCornerCases generates comprehensive trap report', async () => {
    const sampleCode = `
      function twoSum(nums, target) {
        for (let i = 0; i < nums.length; i++) {
          for (let j = i + 1; j < nums.length; j++) {
            if (nums[i] + nums[j] === target) return [i, j];
          }
        }
        return [];
      }
    `;

    const result = await llmService.analyzeCornerCases(sampleCode, 'javascript');
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('Corner Case Sentinel'), 'Report should have Corner Case Sentinel title');
    assert.ok(
      result.includes('Vazio') || result.includes('Array') || result.includes('Overflow') || result.includes('Complexidade'),
      'Report should highlight key corner cases'
    );
  });

  console.log(`\n==========================================`);
  console.log(`🎉 Test Suite Complete: ${passedTests}/${totalTests} Passed!`);
  console.log(`==========================================\n`);

  if (passedTests < totalTests) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
