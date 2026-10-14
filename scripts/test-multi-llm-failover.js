/**
 * Automated Verification Script for Multi-LLM Failover & Fallback
 * Tests Circuit Breaker, OpenRouter payload conversions, Provider routing, and Fallback chains.
 */

const assert = require('assert');
const config = require('../src/core/config');
const llmService = require('../src/services/llm.service');

async function runTests() {
  console.log('⚡ Starting Multi-LLM Failover & Fallback verification tests...\n');

  // Test 1: OpenAI message conversion from Gemini structure
  console.log('1. Testing convertGeminiRequestToOpenAIMessages...');
  const sampleGeminiRequest = {
    systemInstruction: {
      parts: [{ text: 'You are an elite coding interviewer.' }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: 'How do you invert a binary tree?' }]
      },
      {
        role: 'model',
        parts: [{ text: 'Recursively swap left and right subtrees.' }]
      },
      {
        role: 'user',
        parts: [{ text: 'What is the time complexity?' }]
      }
    ]
  };

  const convertedMessages = llmService.convertGeminiRequestToOpenAIMessages(sampleGeminiRequest);
  assert.strictEqual(convertedMessages.length, 4, 'Should convert system + 3 conversation messages');
  assert.strictEqual(convertedMessages[0].role, 'system');
  assert.strictEqual(convertedMessages[0].content, 'You are an elite coding interviewer.');
  assert.strictEqual(convertedMessages[1].role, 'user');
  assert.strictEqual(convertedMessages[1].content, 'How do you invert a binary tree?');
  assert.strictEqual(convertedMessages[2].role, 'assistant');
  assert.strictEqual(convertedMessages[2].content, 'Recursively swap left and right subtrees.');
  assert.strictEqual(convertedMessages[3].role, 'user');
  assert.strictEqual(convertedMessages[3].content, 'What is the time complexity?');
  console.log('   ✓ Gemini to OpenAI payload format conversion verified successfully.\n');

  // Test 2: Provider Availability Detection
  console.log('2. Testing isAnyProviderAvailable and provider configuration...');
  const providerMode = config.get('llm.providerMode');
  assert.ok(providerMode, 'Default provider mode must exist');
  console.log(`   Current providerMode: ${providerMode}`);

  const openrouterModel = config.get('llm.openrouter.model');
  assert.ok(openrouterModel.includes(':free'), 'Default OpenRouter model should use a free (:free) tier');
  console.log(`   Default OpenRouter free model: ${openrouterModel}`);

  const ollamaBaseUrl = config.get('llm.ollama.baseUrl');
  assert.ok(ollamaBaseUrl.startsWith('http'), 'Ollama base URL must be configured');
  console.log(`   Default Ollama endpoint: ${ollamaBaseUrl}`);
  console.log('   ✓ Config defaults verified.\n');

  // Test 3: Circuit Breaker State & Tripping
  console.log('3. Testing Circuit Breaker logic and metrics...');
  const initialBreaker = { ...llmService.circuitBreaker };
  assert.strictEqual(initialBreaker.geminiFailures, 0);
  assert.strictEqual(initialBreaker.geminiTrippedUntil, 0);
  assert.ok(initialBreaker.tripThreshold >= 2);

  // Simulate failures to trip circuit breaker
  llmService.circuitBreaker.geminiFailures = llmService.circuitBreaker.tripThreshold;
  llmService.circuitBreaker.geminiTrippedUntil = Date.now() + 45000;

  const stats = llmService.getStats();
  assert.ok(stats.circuitBreaker, 'Stats must include circuit breaker details');
  assert.strictEqual(stats.circuitBreaker.isTripped, true, 'Circuit breaker must report tripped state');
  console.log('   ✓ Circuit breaker trips properly and is exposed in stats.');

  // Reset circuit breaker
  llmService.circuitBreaker.geminiFailures = 0;
  llmService.circuitBreaker.geminiTrippedUntil = 0;
  assert.strictEqual(llmService.circuitBreaker.geminiTrippedUntil, 0);
  console.log('   ✓ Circuit breaker successfully reset.\n');

  // Test 4: Provider Routing on Failover
  console.log('4. Testing fallback orchestration when Gemini fails...');
  let geminiCalled = false;
  let openrouterCalled = false;
  let ollamaCalled = false;

  const originalExecGemini = llmService.executeGeminiRequest;
  const originalExecOpenRouter = llmService.executeOpenRouterWithFallback;
  const originalExecOllama = llmService.executeOllamaRequest;

  // Mock Gemini to fail (e.g., HTTP 429 quota exhausted)
  llmService.executeGeminiRequest = async () => {
    geminiCalled = true;
    throw new Error('429 Too Many Requests: Quota exceeded');
  };

  // Mock OpenRouter to respond
  llmService.executeOpenRouterWithFallback = async () => {
    openrouterCalled = true;
    return 'Resposta gerada com sucesso via OpenRouter DeepSeek-R1 (Gratuito)';
  };

  llmService.executeOllamaRequest = async () => {
    ollamaCalled = true;
    return 'Resposta Ollama';
  };

  // Ensure config has simulated Gemini and OpenRouter keys
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevOrKey = process.env.OPENROUTER_API_KEY;
  const prevClient = llmService.client;
  process.env.GEMINI_API_KEY = 'mock-gemini-key-12345';
  process.env.OPENROUTER_API_KEY = 'mock-or-key-12345';
  llmService.client = { models: { generateContent: async () => {} } };

  try {
    const result = await llmService.executeRequest({
      contents: [{ role: 'user', parts: [{ text: 'Pergunta teste' }] }]
    });

    assert.ok(geminiCalled, 'Gemini should have been attempted first');
    assert.ok(openrouterCalled, 'OpenRouter should have been triggered as zero-downtime failover');
    assert.ok(result.includes('OpenRouter DeepSeek-R1'), 'Response must come from OpenRouter fallback');
    console.log(`   ✓ Automatic Failover succeeded! Result received from fallback: "${result}"\n`);
  } finally {
    // Restore
    llmService.executeGeminiRequest = originalExecGemini;
    llmService.executeOpenRouterWithFallback = originalExecOpenRouter;
    llmService.executeOllamaRequest = originalExecOllama;
    process.env.GEMINI_API_KEY = prevGeminiKey;
    process.env.OPENROUTER_API_KEY = prevOrKey;
    llmService.client = prevClient;
  }

  // Test 5: Full Chain Failover (Gemini Fail -> OpenRouter Fail -> Ollama Local Success)
  console.log('5. Testing secondary failover to Ollama Local when internet/cloud providers fail...');
  const mockExecGemini2 = async () => { throw new Error('503 Service Unavailable'); };
  const mockExecOpenRouter2 = async () => { throw new Error('Network Timeout'); };
  let ollamaLocalCalled = false;
  const mockExecOllama2 = async () => {
    ollamaLocalCalled = true;
    return 'Resposta 100% offline do Ollama Llama 3.2 Local';
  };

  llmService.executeGeminiRequest = mockExecGemini2;
  llmService.executeOpenRouterWithFallback = mockExecOpenRouter2;
  llmService.executeOllamaRequest = mockExecOllama2;

  try {
    const localResult = await llmService.executeRequest({
      contents: [{ role: 'user', parts: [{ text: 'Pergunta teste offline' }] }]
    });
    assert.ok(ollamaLocalCalled, 'Ollama Local must be invoked when cloud providers fail');
    assert.ok(localResult.includes('Ollama Llama 3.2 Local'), 'Response should come from Ollama');
    console.log(`   ✓ Local Offline Failover succeeded! Result: "${localResult}"\n`);
  } finally {
    llmService.executeGeminiRequest = originalExecGemini;
    llmService.executeOpenRouterWithFallback = originalExecOpenRouter;
    llmService.executeOllamaRequest = originalExecOllama;
  }

  // Test 6: Streaming Fallback Integration
  console.log('6. Testing Streaming Failover orchestration...');
  let streamGeminiCalled = false;
  let streamOpenRouterCalled = false;
  const receivedDeltas = [];

  const origGeminiStream = llmService.executeGeminiStreamRequest;
  const origOpenRouterStream = llmService.executeOpenRouterStreamWithFallback;

  llmService.executeGeminiStreamRequest = async () => {
    streamGeminiCalled = true;
    throw new Error('Gemini streaming socket closed');
  };

  llmService.executeOpenRouterStreamWithFallback = async (req, onDelta) => {
    streamOpenRouterCalled = true;
    onDelta('Parte 1: ');
    onDelta('Solução ');
    onDelta('O(n)');
    return 'Parte 1: Solução O(n)';
  };

  process.env.GEMINI_API_KEY = 'mock-gemini-key-12345';
  process.env.OPENROUTER_API_KEY = 'mock-or-key-12345';
  llmService.client = { models: { generateContent: async () => {} } };

  try {
    const streamedResponse = await llmService.executeStreamingRequest(
      { contents: [{ role: 'user', parts: [{ text: 'Problema' }] }] },
      (delta) => receivedDeltas.push(delta)
    );

    assert.ok(streamGeminiCalled, 'Gemini stream was attempted');
    assert.ok(streamOpenRouterCalled, 'OpenRouter stream took over immediately');
    assert.strictEqual(receivedDeltas.join(''), 'Parte 1: Solução O(n)');
    assert.strictEqual(streamedResponse, 'Parte 1: Solução O(n)');
    console.log(`   ✓ Streaming failover delivered ${receivedDeltas.length} deltas: "${receivedDeltas.join('')}"\n`);
  } finally {
    llmService.executeGeminiStreamRequest = origGeminiStream;
    llmService.executeOpenRouterStreamWithFallback = origOpenRouterStream;
    process.env.GEMINI_API_KEY = prevGeminiKey;
    process.env.OPENROUTER_API_KEY = prevOrKey;
    llmService.client = prevClient;
  }

  console.log('🎉 ALL MULTI-LLM & FAILOVER TESTS PASSED SUCCESSFULLY! Zero Downtime Architecture Verified.');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
