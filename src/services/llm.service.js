const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');
const { getLanguageTitle, getLanguageFence } = require('../core/languages');

class LLMService {
  constructor() {
    this.client = null;
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this._interviewContext = null;

    // Multi-LLM provider statistics and circuit breaker state
    this.providerStats = {
      gemini: { requests: 0, successes: 0, failures: 0 },
      openrouter: { requests: 0, successes: 0, failures: 0 },
      ollama: { requests: 0, successes: 0, failures: 0 }
    };
    this.circuitBreaker = {
      geminiFailures: 0,
      geminiTrippedUntil: 0,
      tripThreshold: 2,
      resetTimeoutMs: 45000 // 45s before attempting Gemini again
    };

    this.initializeClient();
  }

  /**
   * Optional local, gitignored files (candidate-profile.md, job-description.md
   * at the repo root) that personalize interview-mode answers with the
   * candidate's real background instead of generic textbook answers. Missing
   * files are fine — interview mode just falls back to generic answers.
   * Cached after first read since these don't change mid-session.
   */
  _loadInterviewContext(queryText = '') {
    const readIfExists = (fileName) => {
      try {
        const filePath = path.join(__dirname, '..', '..', fileName);
        return fs.readFileSync(filePath, 'utf8').trim();
      } catch (_) {
        return '';
      }
    };

    let staticContext = this._interviewContext;
    if (staticContext === null) {
      const profile = readIfExists('candidate-profile.md');
      const jobDescription = readIfExists('job-description.md');

      let context = '';
      if (profile) {
        context += `\n\n## Candidate background (use these real experiences when relevant instead of generic answers):\n\n${profile}`;
      }
      if (jobDescription) {
        context += `\n\n## The role being interviewed for (tailor answers toward this when relevant):\n\n${jobDescription}`;
      }
      this._interviewContext = context;
      staticContext = context;
    }

    let dynamicStarContext = '';
    try {
      const knowledgeRagManager = require('../managers/knowledge-rag.manager');
      if (queryText && typeof knowledgeRagManager.formatPromptInjection === 'function') {
        dynamicStarContext = knowledgeRagManager.formatPromptInjection(queryText);
      }
    } catch (_) {}

    return `${staticContext}${dynamicStarContext ? `\n${dynamicStarContext}` : ''}`;
  }

  initializeClient() {
    const apiKey = config.getApiKey('GEMINI');
    
    if (apiKey && apiKey !== 'your-api-key-here') {
      try {
        this.client = new GoogleGenAI({ apiKey });
        this.model = config.get('llm.gemini.model');
        this.isInitialized = true;
        logger.info('Gemini AI client initialized successfully', { model: this.model });
      } catch (error) {
        logger.error('Failed to initialize Gemini client', { error: error.message });
      }
    } else {
      logger.info('Gemini API key not configured or placeholder, checking alternative LLM providers...');
    }

    const hasOpenRouter = !!(config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY) && (config.getApiKey('OPENROUTER') !== 'your-openrouter-key');
    const hasOllama = !!config.get('llm.ollama.baseUrl');

    if (this.isInitialized || hasOpenRouter || hasOllama) {
      this.isInitialized = true;
      logger.info('LLM service ready', {
        providerMode: config.get('llm.providerMode', 'auto_failover'),
        hasGemini: !!this.client,
        hasOpenRouter,
        hasOllama
      });
    } else {
      logger.warn('No LLM providers available (Gemini, OpenRouter, or Ollama).');
    }
  }

  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.gemini.generation') || {};
    const fallback = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };

    const merged = { ...fallback, ...defaults, ...overrides };
    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null)
    );
  }

  applyGenerationDefaults(request, overrides = {}) {
    request.generationConfig = this.getGenerationConfig({ ...(request.generationConfig || {}), ...overrides });
    return request;
  }

  applySkillGenerationDefaults(request, activeSkill, isTranscription = false) {
    let maxOutputTokens;
    if (activeSkill === 'interview') {
      maxOutputTokens = 320;
    } else if (isTranscription) {
      maxOutputTokens = 450;
    }
    return this.applyGenerationDefaults(
      request,
      maxOutputTokens ? { maxOutputTokens } : {}
    );
  }

  extractTextFromCandidates(response) {
    // New @google/genai SDK exposes response.text as a convenience getter.
    if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
      return {
        text: response.text.trim(),
        candidate: response.candidates?.[0] || null,
        finishReason: response.candidates?.[0]?.finishReason || null
      };
    }

    const candidates = Array.isArray(response?.candidates)
      ? response.candidates
      : Array.isArray(response)
        ? response
        : [];

    if (!candidates.length) {
      throw new Error('No candidates in Gemini response');
    }

    const candidateWithText = candidates.find(candidate => {
      const parts = candidate?.content?.parts;
      return Array.isArray(parts) && parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0);
    });

    if (!candidateWithText) {
      const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
      throw new Error(`No text parts in candidates. Finish reasons: ${finishReasons}`);
    }

    const textParts = candidateWithText.content.parts
      .filter(part => typeof part.text === 'string' && part.text.trim().length > 0)
      .map(part => part.text.trim());

    if (!textParts.length) {
      throw new Error(`Candidate parts missing text after filtering: ${JSON.stringify(candidateWithText)}`);
    }

    const text = textParts.join('\n');

    return {
      text,
      candidate: candidateWithText,
      finishReason: candidateWithText.finishReason || null
    };
  }

  /**
   * Process an image directly with Gemini using the active skill prompt.
   * The image buffer is sent as inlineData alongside a concise instruction.
   * For image-based queries, we include the skill prompt (e.g., DSA) as systemInstruction.
   * @param {Buffer} imageBuffer - PNG/JPEG image bytes
   * @param {string} mimeType - e.g., 'image/png' or 'image/jpeg'
   * @param {string} activeSkill - current skill (e.g. 'dsa')
   * @param {Array} sessionMemory - optional (not required for image)
   * @param {string|null} programmingLanguage - optional language context for skills that need it
   * @returns {Promise<{response: string, metadata: object}>}
   */
  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      // Build system instruction using the skill prompt (with optional language injection)
      const { promptLoader } = require('../../prompt-loader');
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';

      // Build request with text + image parts
      const base64 = imageBuffer.toString('base64');

      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };

      this.applySkillGenerationDefaults(request, activeSkill);

      if (skillPrompt && skillPrompt.trim().length > 0) {
        request.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      // Execute with retries/timeout - try alternative method first for network reliability
      let responseText;
      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for reliability');
          responseText = await this.executeAlternativeRequest(request);
        } else {
          responseText = await this.executeRequest(request);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, { error: error.message });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);

        try {
          responseText = await secondaryFn(request);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed', {
            firstError: error.message,
            secondError: secondaryError.message
          });
          throw secondaryError;
        }
      }

      // Enforce language in code fences if provided
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(responseText, programmingLanguage)
        : responseText;

      logger.logPerformance('LLM image processing', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM image processing failed', {
        error: error.message,
        activeSkill,
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse('[image]', activeSkill);
      }
      throw error;
    }
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkillStream');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const { promptLoader } = require('../../prompt-loader');
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
      const base64 = imageBuffer.toString('base64');

      const geminiRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };
      this.applySkillGenerationDefaults(geminiRequest, activeSkill);
      if (skillPrompt && skillPrompt.trim().length > 0) {
        geminiRequest.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM image streaming', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      logger.warn('Streaming image analysis failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
    return `Analyze this image for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote}`;
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing text with LLM', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for text processing');
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          response = await this.executeRequest(geminiRequest);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed for text processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }
      
      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }

      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM text streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true
        }
      };
    } catch (error) {
      logger.warn('Streaming text failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing transcription with intelligent response', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for transcription processing');
          response = await this.executeAlternativeRequest(geminiRequest);
        } else {
          response = await this.executeRequest(geminiRequest);
        }
      } catch (error) {
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest);
        } catch (secondaryError) {
          logger.error('Both Gemini request methods failed for transcription processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }
      
      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM transcription processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM transcription processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }
      
      throw error;
    }
  }

  /**
   * Normalize all triple-backtick code fences to the selected programming language tag.
   * Does not alter the inner code; only ensures fence language tags are correct.
   */
  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const fenceTag = getLanguageFence(programmingLanguage);

      // Replace all triple-backtick fences' language token with the selected tag
      const replacedBackticks = text.replace(/```([^\n]*)\n/g, (match, info) => {
        const current = (info || '').trim();
        // If already the desired fenceTag as the first token, keep as is
        if (current.split(/\s+/)[0].toLowerCase() === fenceTag) return match;
        return '```' + fenceTag + '\n';
      });

      // Optionally normalize tildes fences to backticks with correct tag
      const normalizedTildes = replacedBackticks.replace(/~~~([^\n]*)\n/g, () => '```' + fenceTag + '\n');

      return normalizedTildes;
    } catch (_) {
      return text;
    }
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to old method for compatibility - now with programming language support
    const requestComponents = promptLoader.getRequestComponents(
      activeSkill, 
      text, 
      sessionMemory,
      programmingLanguage
    );

    const request = {
      contents: []
    };

    this.applySkillGenerationDefaults(request, activeSkill);

    // Use the skill prompt that already has programming language injected
    if (requestComponents.shouldUseModelMemory && requestComponents.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: requestComponents.skillPrompt }]
      };
      
      logger.debug('Using language-enhanced system instruction for skill', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: requestComponents.skillPrompt.length,
        requiresProgrammingLanguage: requestComponents.requiresProgrammingLanguage
      });
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: this.formatUserMessage(text, activeSkill) }]
    });

    return request;
  }

  buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applySkillGenerationDefaults(request, activeSkill);

    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: skillContext.skillPrompt }]
      };
      
      logger.debug('Using skill context prompt as system instruction', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: skillContext.skillPrompt.length,
        requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false,
        hasLanguageInjection: programmingLanguage && skillContext.requiresProgrammingLanguage
      });
    }

    // Add conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .map(event => {
        const content = event.content.trim();
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      });

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Format and validate the current user input
    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || formattedMessage.trim().length === 0) {
      throw new Error('Failed to format user message or message is empty');
    }

    // Add the current user input
    request.contents.push({
      role: 'user',
      parts: [{ text: formattedMessage }]
    });

    logger.debug('Built Gemini request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSystemInstruction: !!request.systemInstruction,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Validate input text first
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildIntelligentTranscriptionRequestWithHistory(cleanText, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to basic intelligent request
    const request = {
      contents: []
    };

    this.applySkillGenerationDefaults(request, activeSkill, true);

    // Add intelligent filtering system instruction
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    if (!intelligentPrompt) {
      throw new Error('Failed to generate intelligent transcription prompt');
    }

    request.systemInstruction = {
      parts: [{ text: intelligentPrompt }]
    };

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    logger.debug('Built basic intelligent transcription request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      textLength: cleanText.length,
      hasSystemInstruction: !!request.systemInstruction
    });

    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applySkillGenerationDefaults(request, activeSkill, true);

  // For chat/transcription messages, DO NOT include the full skill prompt; use only the intelligent filter prompt
  const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
  request.systemInstruction = { parts: [{ text: intelligentPrompt }] };

    // Add recent conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        // Filter out system messages and ensure content exists and is valid
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .slice(-8) // Keep last 8 exchanges for context
      .map(event => {
        const content = event.content.trim();
        if (!content) {
          logger.warn('Empty content found in conversation history', { event });
          return null;
        }
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      })
      .filter(content => content !== null); // Remove any null entries

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Validate and add the current transcription
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided');
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    // Ensure we have at least one content item
    if (request.contents.length === 0) {
      throw new Error('No valid content to send to Gemini API');
    }

    logger.debug('Built intelligent transcription request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSkillPrompt: !!skillContext.skillPrompt,
      cleanTextLength: cleanText.length,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    if (activeSkill === 'interview') {
      return `# Live Interview Answer System

You are helping a candidate answer questions a recruiter/interviewer is asking out loud, right now, in a live call. The candidate reads or paraphrases your answer immediately, so it must be directly usable in speech.

## Response Rules:
- ALWAYS answer the question directly. Never ask the user to clarify or "provide a problem" — if ambiguous, answer the most likely interpretation.
- Write in first person, as the candidate would speak ("I'd approach this by...", "In my experience...").
- Default to plain prose. Only use a code block if the question explicitly asks to write or see code.
- Keep answers easy to scan during a call: usually 2-3 short sentences (about 30-60 words). For a behavioral question, use at most 4 short sentences. Add detail only when the question has multiple parts or explicitly asks for it.
- Lead with the answer. Skip introductions, repeated questions, filler, and closing summaries.
- No headers, no bullet-point essays, no meta-commentary about being an AI.
- If the transcription is just casual chatter with no real question (e.g. "hello", "can you hear me"), give a brief natural acknowledgment instead of a long answer.
- For behavioral/experience questions, draw on the candidate's real background below instead of inventing a generic anecdote. Pick the most relevant real project/role and speak specifically (company, stack, outcome) rather than vaguely.

## Answer shape:
- Conceptual/technical question (e.g. complexity, how something works, trade-offs): direct answer in the first sentence, then 1-3 sentences of reasoning or a tiny example.
- Behavioral/experience question: short, concrete, situation-action-result answer grounded in the candidate's real history below.
- Small talk or yes/no: one or two natural sentences.

Tone: confident, concise, conversational — a well-prepared candidate thinking out loud, not a textbook.${this._loadInterviewContext(text)}`;
    }

    let prompt = `# Intelligent Transcription Response System

Assume you are asked a question in ${activeSkill.toUpperCase()} mode. Your job is to intelligently respond to question/message with appropriate brevity.
Assume you are in an interview and you need to perform best in ${activeSkill.toUpperCase()} mode.
Always respond to the point, do not repeat the question or unnecessary information which is not related to ${activeSkill}.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      const languageTitle = getLanguageTitle(programmingLanguage);
      const fenceTag = getLanguageFence(programmingLanguage);
      prompt += `\n\nCODING CONTEXT: Respond ONLY in ${languageTitle}. All code blocks must use triple backticks with language tag \`\`\`${fenceTag}\`\`\`. Do not include other languages unless explicitly asked.`;
    }

    prompt += `

## Response Rules:

### If the transcription is casual conversation, greetings, or NOT related to ${activeSkill}:
- Respond with: "Yeah, I'm listening. Ask your question relevant to ${activeSkill}."
- Or similar brief acknowledgments like: "I'm here, what's your ${activeSkill} question?"

### If the transcription IS relevant to ${activeSkill} or is a follow-up question:
- Provide a prompt, direct response with appropriate brevity.
- Lead immediately with the key answer, insight, or solution.
- Keep explanations clear and concise (2-4 sentences) so they can be parsed immediately during a live call.
- If code is required, output only the clean, optimal snippet without unnecessary boilerplate or repetition.

## Response Format:
- Direct, concise, and focused on ${activeSkill}
- Lead with the answer; avoid introductory filler or repeating the question
- If the user's input is a coding or DSA problem statement, produce a clean, optimal solution in the selected programming language in a properly tagged code block without excessive conversational fluff.

Remember: Be intelligent about filtering - provide quick, direct responses so the user gets help immediately.`;

    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  isAnyProviderAvailable() {
    const hasGemini = !!this.client && !!config.getApiKey('GEMINI') && config.getApiKey('GEMINI') !== 'your-api-key-here';
    const orKey = config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY;
    const hasOpenRouter = !!orKey && orKey !== 'your-openrouter-key';
    const hasOllama = !!config.get('llm.ollama.baseUrl');
    return hasGemini || hasOpenRouter || hasOllama;
  }

  convertGeminiRequestToOpenAIMessages(geminiRequest) {
    const messages = [];

    // System instruction
    if (geminiRequest && geminiRequest.systemInstruction) {
      let sysText = '';
      if (typeof geminiRequest.systemInstruction === 'string') {
        sysText = geminiRequest.systemInstruction;
      } else if (geminiRequest.systemInstruction.parts && Array.isArray(geminiRequest.systemInstruction.parts)) {
        sysText = geminiRequest.systemInstruction.parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
      }
      if (sysText.trim()) {
        messages.push({ role: 'system', content: sysText.trim() });
      }
    }

    // Contents
    if (geminiRequest && Array.isArray(geminiRequest.contents)) {
      geminiRequest.contents.forEach(item => {
        if (!item) return;
        const role = item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user';
        let contentText = '';
        if (typeof item === 'string') {
          contentText = item;
        } else if (Array.isArray(item.parts)) {
          contentText = item.parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
        } else if (item.parts && typeof item.parts === 'string') {
          contentText = item.parts;
        } else if (item.text) {
          contentText = item.text;
        }
        if (contentText.trim()) {
          messages.push({ role, content: contentText.trim() });
        }
      });
    }

    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Olá' });
    }

    return messages;
  }

  async executeOpenRouterRequest(geminiRequest, modelOverride = null) {
    const apiKey = config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your-openrouter-key') {
      throw new Error('Chave da API do OpenRouter não configurada.');
    }

    const messages = this.convertGeminiRequestToOpenAIMessages(geminiRequest);
    const model = modelOverride || config.get('llm.openrouter.model', 'deepseek/deepseek-r1:free');
    const maxTokens = (geminiRequest.generationConfig && geminiRequest.generationConfig.maxOutputTokens) || 2048;
    const temperature = (geminiRequest.generationConfig && geminiRequest.generationConfig.temperature) || 0.7;
    const timeout = config.get('llm.openrouter.timeout', 25000);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    this.providerStats.openrouter.requests++;
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': config.get('llm.openrouter.siteUrl', 'https://github.com/TechyCSR/OpenCluely'),
          'X-Title': config.get('llm.openrouter.siteName', 'OpenCluely'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const json = await response.json();
      const choice = json.choices && json.choices[0];
      const answer = (choice && choice.message && choice.message.content) || '';
      if (!answer) {
        throw new Error('Resposta vazia recebida do OpenRouter');
      }

      this.providerStats.openrouter.successes++;
      logger.info('OpenRouter request succeeded', { model, length: answer.length });
      return answer.trim();
    } catch (err) {
      clearTimeout(timeoutId);
      this.providerStats.openrouter.failures++;
      throw err;
    }
  }

  async executeOpenRouterStreamRequest(geminiRequest, onDelta, modelOverride = null) {
    const apiKey = config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your-openrouter-key') {
      throw new Error('Chave da API do OpenRouter não configurada.');
    }

    const messages = this.convertGeminiRequestToOpenAIMessages(geminiRequest);
    const model = modelOverride || config.get('llm.openrouter.model', 'deepseek/deepseek-r1:free');
    const maxTokens = (geminiRequest.generationConfig && geminiRequest.generationConfig.maxOutputTokens) || 2048;
    const temperature = (geminiRequest.generationConfig && geminiRequest.generationConfig.temperature) || 0.7;
    const timeout = config.get('llm.openrouter.timeout', 25000);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    this.providerStats.openrouter.requests++;
    let accumulatedText = '';
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': config.get('llm.openrouter.siteUrl', 'https://github.com/TechyCSR/OpenCluely'),
          'X-Title': config.get('llm.openrouter.siteName', 'OpenCluely'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter streaming HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                accumulatedText += delta;
                if (typeof onDelta === 'function') onDelta(delta);
              }
            } catch (_) {}
          }
        }
      }

      if (!accumulatedText.trim()) {
        throw new Error('Resposta vazia de streaming recebida do OpenRouter');
      }

      this.providerStats.openrouter.successes++;
      logger.info('OpenRouter streaming succeeded', { model, length: accumulatedText.length });
      return accumulatedText.trim();
    } catch (err) {
      clearTimeout(timeoutId);
      this.providerStats.openrouter.failures++;
      throw err;
    }
  }

  async executeOpenRouterWithFallback(geminiRequest) {
    const primaryModel = config.get('llm.openrouter.model', 'deepseek/deepseek-r1:free');
    const fallbackModels = config.get('llm.openrouter.fallbackModels', [
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen-2.5-coder-32b-instruct:free',
      'google/gemini-2.0-flash-exp:free'
    ]);
    const modelsToTry = [primaryModel, ...fallbackModels.filter(m => m !== primaryModel)];

    let lastErr = null;
    for (const m of modelsToTry) {
      try {
        return await this.executeOpenRouterRequest(geminiRequest, m);
      } catch (err) {
        lastErr = err;
        logger.warn(`OpenRouter model ${m} failed, trying next fallback model...`, { error: err.message });
      }
    }
    throw lastErr || new Error('All OpenRouter models failed');
  }

  async executeOpenRouterStreamWithFallback(geminiRequest, onDelta) {
    const primaryModel = config.get('llm.openrouter.model', 'deepseek/deepseek-r1:free');
    const fallbackModels = config.get('llm.openrouter.fallbackModels', [
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen-2.5-coder-32b-instruct:free',
      'google/gemini-2.0-flash-exp:free'
    ]);
    const modelsToTry = [primaryModel, ...fallbackModels.filter(m => m !== primaryModel)];

    let lastErr = null;
    for (const m of modelsToTry) {
      try {
        return await this.executeOpenRouterStreamRequest(geminiRequest, onDelta, m);
      } catch (err) {
        lastErr = err;
        logger.warn(`OpenRouter streaming model ${m} failed, trying next fallback model...`, { error: err.message });
      }
    }
    throw lastErr || new Error('All OpenRouter streaming models failed');
  }

  async executeOllamaRequest(geminiRequest, modelOverride = null) {
    const baseUrl = config.get('llm.ollama.baseUrl', 'http://localhost:11434');
    const model = modelOverride || config.get('llm.ollama.model', 'llama3.2:3b');
    const messages = this.convertGeminiRequestToOpenAIMessages(geminiRequest);

    const controller = new AbortController();
    const timeout = config.get('llm.ollama.timeout', 20000);
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    this.providerStats.ollama.requests++;
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}`);
      }

      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || '';
      if (!text) throw new Error('Empty response from Ollama');

      this.providerStats.ollama.successes++;
      logger.info('Ollama request succeeded', { model, length: text.length });
      return text.trim();
    } catch (err) {
      clearTimeout(timeoutId);
      this.providerStats.ollama.failures++;
      throw err;
    }
  }

  async executeOllamaStreamRequest(geminiRequest, onDelta, modelOverride = null) {
    const baseUrl = config.get('llm.ollama.baseUrl', 'http://localhost:11434');
    const model = modelOverride || config.get('llm.ollama.model', 'llama3.2:3b');
    const messages = this.convertGeminiRequestToOpenAIMessages(geminiRequest);

    const controller = new AbortController();
    const timeout = config.get('llm.ollama.timeout', 20000);
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    this.providerStats.ollama.requests++;
    let accumulatedText = '';
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                accumulatedText += delta;
                if (typeof onDelta === 'function') onDelta(delta);
              }
            } catch (_) {}
          }
        }
      }

      if (!accumulatedText.trim()) throw new Error('Empty streamed response from Ollama');
      this.providerStats.ollama.successes++;
      return accumulatedText.trim();
    } catch (err) {
      clearTimeout(timeoutId);
      this.providerStats.ollama.failures++;
      throw err;
    }
  }

  async executeGeminiRequest(geminiRequest, timeoutOverride = null) {
    const maxRetries = config.get('llm.gemini.maxRetries', 2);
    const timeout = timeoutOverride || config.get('llm.gemini.timeout', 30000);
    const primaryModel = this.model;
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    let lastError = null;
    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), timeout)
          );

          const requestPromise = this.client.models.generateContent({
            model: modelName,
            contents: geminiRequest.contents,
            config: geminiRequest.generationConfig,
            systemInstruction: geminiRequest.systemInstruction
          });
          const result = await Promise.race([requestPromise, timeoutPromise]);

          if (!result) {
            throw new Error('Empty response from Gemini API');
          }

          const { text } = this.extractTextFromCandidates(result);
          return text;
        } catch (error) {
          lastError = error;
          const isRateOrUnavailable = error.message.includes('429') ||
            error.message.includes('503') ||
            error.message.includes('quota') ||
            error.message.includes('high demand');
          if (isRateOrUnavailable) {
            break; // try next model immediately
          }
        }
      }
    }
    throw lastError || new Error('Gemini request failed');
  }

  async executeRequest(geminiRequest) {
    const providerMode = config.get('llm.providerMode', 'auto_failover');

    // 1. Explicit OpenRouter Mode (Free or Paid)
    if (providerMode === 'openrouter' || providerMode === 'openrouter_free') {
      try {
        return await this.executeOpenRouterWithFallback(geminiRequest);
      } catch (err) {
        logger.warn('OpenRouter primary failed, trying Ollama local fallback...', { error: err.message });
        return await this.executeOllamaRequest(geminiRequest);
      }
    }

    // 2. Explicit Ollama Local Mode
    if (providerMode === 'ollama') {
      return await this.executeOllamaRequest(geminiRequest);
    }

    // 3. Explicit Gemini Only Mode
    if (providerMode === 'gemini_only') {
      return await this.executeGeminiRequest(geminiRequest);
    }

    // 4. Default: AUTO_FAILOVER (Zero-Downtime Circuit Breaker)
    const now = Date.now();
    const isGeminiTripped = this.circuitBreaker.geminiTrippedUntil > now;
    const hasGeminiKey = !!config.getApiKey('GEMINI') && config.getApiKey('GEMINI') !== 'your-api-key-here';

    if (!isGeminiTripped && hasGeminiKey && this.client) {
      try {
        const failoverTimeout = config.get('llm.failoverTimeout', 3500);
        const result = await this.executeGeminiRequest(geminiRequest, failoverTimeout);
        this.circuitBreaker.geminiFailures = 0;
        this.providerStats.gemini.successes++;
        return result;
      } catch (geminiError) {
        this.circuitBreaker.geminiFailures++;
        this.providerStats.gemini.failures++;
        if (this.circuitBreaker.geminiFailures >= this.circuitBreaker.tripThreshold) {
          this.circuitBreaker.geminiTrippedUntil = Date.now() + this.circuitBreaker.resetTimeoutMs;
          logger.warn('Gemini circuit breaker tripped! Routing to OpenRouter failover for 45s', {
            failures: this.circuitBreaker.geminiFailures,
            error: geminiError.message
          });
        }
        logger.warn('Gemini failed/timed out. Switching automatically to OpenRouter free models...', { error: geminiError.message });
      }
    } else {
      logger.info('Gemini skipped (tripped or unconfigured). Engaging failover provider directly.');
    }

    // Failover 1: OpenRouter (with Free LLMs)
    const hasOpenRouterKey = !!(config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY);
    if (hasOpenRouterKey) {
      try {
        logger.info('Executing request via OpenRouter failover...');
        return await this.executeOpenRouterWithFallback(geminiRequest);
      } catch (orErr) {
        logger.warn('OpenRouter failover failed, attempting Ollama...', { error: orErr.message });
      }
    }

    // Failover 2: Ollama Local (100% Offline)
    try {
      logger.info('Executing request via Ollama local failover...');
      return await this.executeOllamaRequest(geminiRequest);
    } catch (ollamaErr) {
      logger.warn('Ollama failover failed', { error: ollamaErr.message });
    }

    throw new Error('Todos os provedores de LLM (Gemini, OpenRouter, Ollama) falharam ou não estão configurados.');
  }

  /**
   * Streaming sibling of processTranscriptionWithIntelligentResponse. Emits
   * incremental text via onDelta so the UI can render the answer as it is
   * generated (much faster perceived latency). Returns the same
   * {response, metadata} shape. Falls back to the non-streaming path on any
   * streaming failure so reliability is never worse than before.
   */
  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) {
          onDelta(delta);
        }
      });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM transcription streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      logger.warn('Streaming transcription failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      // Non-streaming path returns the same shape; the caller renders it as a
      // single final response.
      return this.processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  /** Safely pull the text delta out of a streamed Gemini chunk. */
  _extractChunkText(chunk) {
    try {
      const t = chunk && chunk.text;
      if (typeof t === 'string') {
        return t;
      }
    } catch (_) {
      // `.text` getter can throw on non-text parts; fall through to manual read.
    }
    try {
      const parts = (chunk && chunk.candidates && chunk.candidates[0] &&
        chunk.candidates[0].content && chunk.candidates[0].content.parts) || [];
      return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    } catch (_) {
      return '';
    }
  }

  /**
   * Run a streaming Gemini request with the same model-fallback + retry policy
   * as executeRequest. Accumulates and returns the full text; invokes onDelta
   * for each chunk.
   */
  /**
   * Orchestrates streaming requests with Circuit Breaker and Multi-LLM failover:
   * Gemini -> OpenRouter (free/paid) -> Ollama local.
   */
  async executeStreamingRequest(geminiRequest, onDelta) {
    const providerMode = config.get('llm.providerMode', 'auto_failover');

    // 1. Explicit OpenRouter Mode (Free or Paid)
    if (providerMode === 'openrouter' || providerMode === 'openrouter_free') {
      try {
        return await this.executeOpenRouterStreamWithFallback(geminiRequest, onDelta);
      } catch (err) {
        logger.warn('OpenRouter stream failed, falling back to Ollama...', { error: err.message });
        return await this.executeOllamaStreamRequest(geminiRequest, onDelta);
      }
    }

    // 2. Explicit Ollama Mode
    if (providerMode === 'ollama') {
      return await this.executeOllamaStreamRequest(geminiRequest, onDelta);
    }

    // 3. Explicit Gemini Only Mode
    if (providerMode === 'gemini_only') {
      return await this.executeGeminiStreamRequest(geminiRequest, onDelta);
    }

    // 4. Default: AUTO_FAILOVER (Zero-Downtime Circuit Breaker)
    const now = Date.now();
    const isGeminiTripped = this.circuitBreaker.geminiTrippedUntil > now;
    const hasGeminiKey = !!config.getApiKey('GEMINI') && config.getApiKey('GEMINI') !== 'your-api-key-here';

    let streamedAnyDelta = false;
    const trackingOnDelta = (delta) => {
      streamedAnyDelta = true;
      if (typeof onDelta === 'function') onDelta(delta);
    };

    if (!isGeminiTripped && hasGeminiKey && this.client) {
      try {
        const result = await this.executeGeminiStreamRequest(geminiRequest, trackingOnDelta);
        this.circuitBreaker.geminiFailures = 0;
        this.providerStats.gemini.successes++;
        return result;
      } catch (geminiError) {
        this.circuitBreaker.geminiFailures++;
        this.providerStats.gemini.failures++;
        if (this.circuitBreaker.geminiFailures >= this.circuitBreaker.tripThreshold) {
          this.circuitBreaker.geminiTrippedUntil = Date.now() + this.circuitBreaker.resetTimeoutMs;
          logger.warn('Gemini stream circuit breaker tripped! Routing to OpenRouter failover', {
            failures: this.circuitBreaker.geminiFailures,
            error: geminiError.message
          });
        }
        logger.warn('Gemini streaming failed. Switching automatically to OpenRouter...', { error: geminiError.message });
      }
    }

    // Failover 1: OpenRouter (with Free LLMs)
    const hasOpenRouterKey = !!(config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY);
    if (hasOpenRouterKey) {
      try {
        logger.info('Executing streaming request via OpenRouter failover...');
        return await this.executeOpenRouterStreamWithFallback(geminiRequest, onDelta);
      } catch (orErr) {
        logger.warn('OpenRouter streaming failover failed, attempting Ollama...', { error: orErr.message });
      }
    }

    // Failover 2: Ollama Local (100% Offline)
    try {
      logger.info('Executing streaming request via Ollama local failover...');
      return await this.executeOllamaStreamRequest(geminiRequest, onDelta);
    } catch (ollamaErr) {
      logger.warn('Ollama streaming failover failed', { error: ollamaErr.message });
    }

    throw new Error('Todos os provedores de streaming (Gemini, OpenRouter, Ollama) falharam ou não estão configurados.');
  }

  async executeGeminiStreamRequest(geminiRequest, onDelta) {
    const maxRetries = config.get('llm.gemini.maxRetries');
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = this.model;
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const fullText = await this._streamRequestForModel(geminiRequest, modelName, apiKey, onDelta);

          if (!fullText) {
            throw new Error('Empty streamed response from Gemini API');
          }

          logger.debug('Gemini streaming request successful', {
            attempt,
            model: modelName,
            responseLength: fullText.length
          });

          return fullText;
        } catch (error) {
          const errorInfo = this.analyzeError(error);
          lastError = error;

          logger.warn(`Gemini streaming attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          // Non-retryable auth errors fail immediately
          if (errorInfo.type === 'AUTH_ERROR') {
            logger.error(`Authentication error during streaming for model ${modelName} — will not retry`, {
              error: error.message
            });
            break;
          }

          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand') ||
            error.message.includes('404') ||
            error.message.includes('NOT_FOUND') ||
            error.message.includes('no longer available');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break; // try next fallback model
          }

          if (attempt === maxRetries) {
            break;
          }

          // Use exponential backoff (500ms -> 1000ms -> 2000ms) with jitter
          const baseDelay = errorInfo.isNetworkError ? 800 : 500;
          const delay = this._computeRetryDelay(attempt, baseDelay);
          await this.delay(delay);
        }
      }
    }

    throw lastError || new Error('Gemini streaming request failed');
  }

  /**
   * Compute exponential backoff delay with jitter
   * @param {number} attempt - Current attempt (1-indexed)
   * @param {number} baseDelay - Base delay in ms (default 500ms)
   * @param {number} maxDelay - Max delay cap in ms (default 4000ms)
   */
  _computeRetryDelay(attempt, baseDelay = 500, maxDelay = 4000) {
    const expDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 250;
    return Math.min(maxDelay, expDelay) + jitter;
  }

  _streamRequestForModel(geminiRequest, modelName, apiKey, onDelta) {
    const https = require('https');
    const timeout = config.get('llm.gemini.timeout');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
    const postData = JSON.stringify(geminiRequest);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout,
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = '';
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              continue;
            }
            try {
              const json = JSON.parse(payload);
              const piece = this._extractChunkText(json);
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') {
                  onDelta(piece);
                }
              }
            } catch (_) {
              // Partial JSON across chunk boundaries is rare with line framing;
              // skip anything that doesn't parse cleanly.
            }
          }
        });

        res.on('end', () => resolve(fullText.trim()));
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  async performPreflightCheck() {
    // Quick connectivity check
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({ 
        host: 'generativelanguage.googleapis.com', 
        port: 443, 
        name: 'Gemini API Endpoint' 
      });
      const latency = Date.now() - startTime;
      
      logger.debug('Preflight check passed', { latency });
    } catch (error) {
      logger.warn('Preflight check failed', { 
        error: error.message,
        suggestion: 'Network connectivity issue detected before API call'
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      // Try to get user agent from Electron if available
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const errorMessage = (error && error.message ? error.message : String(error)).toLowerCase();
    
    // Network connectivity errors
    if (errorMessage.includes('fetch failed') || 
        errorMessage.includes('network error') ||
        errorMessage.includes('enotfound') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('econnreset') ||
        errorMessage.includes('socket hang up') ||
        errorMessage.includes('ehostunreach') ||
        errorMessage.includes('enetunreach') ||
        errorMessage.includes('timeout')) {
      return {
        type: 'NETWORK_ERROR',
        isNetworkError: true,
        isRetryable: true,
        suggestedAction: 'Check internet connection and firewall settings'
      };
    }
    
    // API key errors
    if (errorMessage.includes('unauthorized') || 
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('api_key_invalid') ||
        errorMessage.includes('401') ||
        errorMessage.includes('forbidden') ||
        errorMessage.includes('403')) {
      return {
        type: 'AUTH_ERROR',
        isNetworkError: false,
        isRetryable: false,
        suggestedAction: 'Verify Gemini API key configuration'
      };
    }
    
    // Rate limiting (429 / resource exhausted)
    if (errorMessage.includes('quota') || 
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('429') ||
        errorMessage.includes('resource_exhausted')) {
      return {
        type: 'RATE_LIMIT_ERROR',
        isNetworkError: false,
        isRetryable: true,
        suggestedAction: 'Wait before retrying or check API quota'
      };
    }

    // Service unavailable / server overload (503 / 500)
    if (errorMessage.includes('503') ||
        errorMessage.includes('unavailable') ||
        errorMessage.includes('high demand') ||
        errorMessage.includes('overloaded') ||
        errorMessage.includes('500') ||
        errorMessage.includes('internal error')) {
      return {
        type: 'SERVER_ERROR',
        isNetworkError: false,
        isRetryable: true,
        suggestedAction: 'Wait for upstream Gemini service to recover'
      };
    }
    
    // Timeout errors
    if (errorMessage.includes('request timeout') || errorMessage.includes('etimedout')) {
      return {
        type: 'TIMEOUT_ERROR',
        isNetworkError: true,
        isRetryable: true,
        suggestedAction: 'Check network latency or increase timeout'
      };
    }
    
    return {
      type: 'UNKNOWN_ERROR',
      isNetworkError: false,
      isRetryable: false,
      suggestedAction: 'Check logs for more details'
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = [
      { host: 'google.com', port: 443, name: 'Google (HTTPS)' },
      { host: 'generativelanguage.googleapis.com', port: 443, name: 'Gemini API Endpoint' }
    ];

    const results = await Promise.allSettled(
      connectivityTests.map(test => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    logger.info('Network connectivity check completed', connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`));
      });

      socket.connect(port, host);
    });
  }

  /**
   * Fast translation of transcription text to Brazilian Portuguese.
   * Uses direct Node HTTPS request to avoid Electron Undici fetch issues.
   * @param {string} text - Source text
   * @returns {Promise<string>} Translated text in Portuguese
   */
  async translateToPortuguese(text) {
    if (!text || !text.trim()) return '';
    const cleanText = text.trim();
    const apiKey = config.getApiKey('GEMINI');

    if (apiKey && apiKey !== 'your-api-key-here') {
      const primaryModel = this.model || config.get('llm.gemini.model') || 'gemini-3.1-flash-lite';
      const fallbackModels = config.get('llm.gemini.fallbackModels') || ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];
      const modelsToTry = [primaryModel, ...fallbackModels.filter(m => m !== primaryModel)];

      const prompt = `Translate the following speech transcription into natural Brazilian Portuguese. Return ONLY the translated Portuguese text without any intro, commentary, or quotation marks:\n\n${cleanText}`;
      const geminiRequest = {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 256
        }
      };

      // Primary: direct native HTTPS request (bypasses Electron fetch socket issues)
      for (const modelName of modelsToTry) {
        try {
          const translated = await this._executeAlternativeRequestForModel(geminiRequest, modelName, apiKey);
          if (translated && translated.trim()) {
            return translated.trim();
          }
        } catch (err) {
          logger.warn(`Failed to translate transcription to Portuguese via HTTPS for model ${modelName}`, { error: err.message });
        }
      }

      // Secondary fallback: SDK client if initialized
      if (this.client) {
        for (const modelName of modelsToTry) {
          try {
            const result = await this.client.models.generateContent({
              model: modelName,
              contents: prompt,
              config: this.getGenerationConfig({ temperature: 0.1, maxOutputTokens: 256 })
            });
            const { text: translated } = this.extractTextFromCandidates(result);
            if (translated && translated.trim()) {
              return translated.trim();
            }
          } catch (_) {}
        }
      }
    }

    // Failover: OpenRouter translation
    const orKey = config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY;
    if (orKey && orKey !== 'your-openrouter-key') {
      try {
        const prompt = `Translate the following speech transcription into natural Brazilian Portuguese. Return ONLY the translated Portuguese text without any intro, commentary, or quotation marks:\n\n${cleanText}`;
        const transRequest = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
        };
        const translated = await this.executeOpenRouterWithFallback(transRequest);
        if (translated && translated.trim()) {
          return translated.trim();
        }
      } catch (err) {
        logger.warn('OpenRouter translation fallback failed', { error: err.message });
      }
    }

    return cleanText;
  }

  /**
   * Generate an executive, structured summary of a meeting transcript
   * @param {string} transcriptText - Full transcript text
   * @param {object} options - Options (language, maxTokens, etc.)
   * @returns {Promise<string>} Generated markdown summary
   */
  async summarizeMeetingTranscript(transcriptText, options = {}) {
    if (!transcriptText || typeof transcriptText !== 'string' || !transcriptText.trim()) {
      return 'Nenhuma transcrição foi fornecida para gerar o resumo da reunião.';
    }

    const cleanText = transcriptText.trim();
    const utteranceMatches = cleanText.match(/\[.*?\]\s*\[(SPEAKER|AI ASSISTANT|USER)\]/gi) || [];
    const textLength = cleanText.length;
    
    if (textLength < 30 && utteranceMatches.length === 0) {
      return 'A transcrição da reunião está muito curta ou não contém falas gravadas suficientes para gerar um resumo.';
    }

    if (!this.isAnyProviderAvailable()) {
      return this._generateExtractiveMeetingSummaryFallback(cleanText);
    }

    // Cap transcript if excessively large to avoid payload overflow (~120,000 characters)
    let processedTranscript = cleanText;
    if (processedTranscript.length > 120000) {
      const head = processedTranscript.substring(0, 60000);
      const tail = processedTranscript.substring(processedTranscript.length - 60000);
      processedTranscript = `${head}\n\n[... transcrição intermediária truncada para caber no limite do modelo ...]\n\n${tail}`;
    }

    const targetLang = options.language || config.get('transcripts.summaryLanguage', 'pt-BR');
    const systemPrompt = `Você é um assistente executivo de alto nível, especialista em redigir atas e resumos executivos de reuniões de negócios, técnicas e alinhamentos de equipes.
Seu objetivo é analisar a transcrição completa da reunião e sintetizar todas as discussões em um resumo conciso, claro e acionável em Português do Brasil (${targetLang}).

Formato obrigatório da sua resposta (use exatamente esta estrutura em Markdown):

# 📋 Resumo Executivo da Reunião

## 🎯 Visão Geral & Contexto
(2 a 3 frases sintetizando o propósito da reunião, os principais temas tratados e o resultado geral da conversa)

## 💬 Tópicos Principais Abordados
- **Tópico 1**: Detalhe conciso do que foi discutido
- **Tópico 2**: Detalhe conciso do que foi discutido
(inclua todos os tópicos relevantes)

## ✅ Decisões & Alinhamentos
- Decisões tomadas ou consensos estabelecidos (se não houver decisões explícitas, sintetize os alinhamentos ou conclusões)

## 🚀 Próximos Passos & Ações (Action Items)
- **[Ação]**: O que precisa ser feito, responsável e prazo (se mencionados na reunião)

## 💡 Destaques & Pontos Relevantes
- Perguntas essenciais respondidas, alertas ou pontos críticos mencionados

Diretrizes estritas:
- Seja objetivo e vá direto ao ponto, eliminando hesitações, ruídos, cumprimentos triviais e repetições.
- Mantenha termos técnicos comuns da indústria no formato original quando apropriado (ex: PR, branch, deploy, sprint, backlog, deadline).
- Não invente informações inexistentes na transcrição.`;

    const userPrompt = `Abaixo está a transcrição completa da reunião gravada:\n\n---\n${processedTranscript}\n---\n\nGere agora o resumo executivo conciso e estruturado da reunião em Markdown conforme as instruções.`;

    const geminiRequest = {
      contents: [{
        role: 'user',
        parts: [{ text: userPrompt }]
      }],
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemPrompt }]
      },
      generationConfig: this.getGenerationConfig({
        temperature: 0.3,
        maxOutputTokens: 2048,
        topP: 0.95
      })
    };

    try {
      logger.info('Generating meeting summary via LLM', {
        transcriptLength: cleanText.length,
        utteranceCount: utteranceMatches.length
      });

      let summary;
      try {
        summary = await this.executeRequest(geminiRequest);
      } catch (reqError) {
        logger.warn('executeRequest failed for meeting summary, trying executeAlternativeRequest', { error: reqError.message });
        summary = await this.executeAlternativeRequest(geminiRequest);
      }

      if (summary && summary.trim()) {
        return summary.trim();
      }
      return this._generateExtractiveMeetingSummaryFallback(cleanText);
    } catch (error) {
      logger.error('Failed to generate meeting summary with LLM', { error: error.message });
      return this._generateExtractiveMeetingSummaryFallback(cleanText, error.message);
    }
  }

  /**
   * Fallback extractive summary when Gemini is offline or unconfigured
   */
  _generateExtractiveMeetingSummaryFallback(transcriptText, errorMessage = null) {
    const lines = transcriptText.split('\n').filter(l => l.trim().length > 0);
    const speechLines = lines.filter(l => l.includes('[SPEAKER]') || l.includes('[USER]') || l.includes('[AI ASSISTANT]'));
    
    // Extract metadata
    const dateLine = lines.find(l => l.includes('Session Date:')) || '';
    const modeLine = lines.find(l => l.includes('Mode / Skill:')) || '';
    const durationLine = lines.find(l => l.includes('Duration:')) || '';
    const totalWordsLine = lines.find(l => l.includes('Total Words Spoken:')) || '';

    const sampleLines = speechLines.slice(0, 10).map(l => {
      const match = l.match(/\[.*?\]\s*\[(.*?)\]\s*(.*)/);
      if (match) {
        return `- **${match[1]}**: ${match[2]}`;
      }
      return `- ${l}`;
    }).join('\n');

    let fallback = `# 📋 Resumo da Reunião (Modo Estruturado Offline)

${dateLine ? `> **Data**: ${dateLine.replace('Session Date:', '').trim()}\n` : ''}${durationLine ? `> **Duração**: ${durationLine.replace('Duration:', '').trim()}\n` : ''}${totalWordsLine ? `> **Palavras Registradas**: ${totalWordsLine.replace('Total Words Spoken:', '').trim()}\n` : ''}

## 💬 Falas Registradas na Sessão (${speechLines.length} falas)
${sampleLines || '_Nenhuma fala com identificador de participante encontrada na transcrição._'}
${speechLines.length > 10 ? `\n_... e mais ${speechLines.length - 10} falas registradas no arquivo completo._` : ''}

---
💡 *Nota: Configure sua chave de API Gemini no OpenCluely para habilitar síntese executiva por IA completa com identificação automática de decisões e action items.*`;

    if (errorMessage) {
      fallback += `\n\n*(Aviso: Tentativa de síntese por IA retornou: ${errorMessage})*`;
    }

    return fallback;
  }

  /**
   * Generate 3 fast, strategic talking points (Smart Talking Points) for a question or discussion topic
   * @param {string} questionText - Spoken question or topic
   * @param {string} activeSkill - Active skill (e.g. 'interview', 'dsa')
   * @param {Array} sessionMemory - Recent conversation exchanges
   * @returns {Promise<{ points: string[], raw: string }>}
   */
  async generateSmartTalkingPoints(questionText, activeSkill = 'interview', sessionMemory = []) {
    if (!questionText || typeof questionText !== 'string' || !questionText.trim()) {
      return { points: [], raw: '' };
    }

    const cleanQuestion = questionText.trim();
    if (cleanQuestion.length < 5) {
      return { points: [], raw: '' };
    }

    if (!this.isAnyProviderAvailable()) {
      return this._generateTalkingPointsFallback(cleanQuestion, activeSkill);
    }

    try {
      const interviewContext = this._loadInterviewContext(cleanQuestion);
      const systemPrompt = `Você é um co-piloto de IA de altíssima velocidade para candidatos em entrevistas técnicas e comportamentais.
O entrevistador acabou de fazer uma pergunta. Seu objetivo é gerar EXATAMENTE 3 marcadores estratégicos de resposta rápida (Talking Points).
Eles devem permitir que o candidato comece a falar nos próximos 3 segundos com segurança e sem hesitar, cobrindo a resposta em alto nível enquanto elabora os detalhes.

Regras de Ouro:
1. Retorne EXATAMENTE 3 tópicos numerados:
1. [Abordagem Direta]: ...
2. [Exemplo Concreto / Arquitetura]: ...
3. [Trade-off / Diferencial]: ...
2. Seja ultra-conciso: no máximo 10 a 14 palavras por ponto.
3. Use tom de candidato em primeira pessoa ("Abordar via...", "Citar caso de uso com...", "Destacar trade-off de...").
4. Idioma preferencial: Português do Brasil (ou o idioma da pergunta).
5. Não adicione introduções, conclusões ou saudações. Apenas os 3 tópicos numerados.${interviewContext}`;

      const userPrompt = `Pergunta do Entrevistador:\n"${cleanQuestion}"\n\nGere os 3 Talking Points estratégicos agora:`;

      const request = {
        contents: [{
          role: 'user',
          parts: [{ text: userPrompt }]
        }],
        systemInstruction: {
          role: 'system',
          parts: [{ text: systemPrompt }]
        },
        generationConfig: this.getGenerationConfig({
          temperature: 0.3,
          maxOutputTokens: 220,
          thinkingConfig: { thinkingBudget: 0 }
        })
      };

      const rawResponse = await this.executeRequest(request);
      const points = this._parseTalkingPoints(rawResponse);
      return {
        points: points.length > 0 ? points : this._generateTalkingPointsFallback(cleanQuestion, activeSkill).points,
        raw: rawResponse
      };
    } catch (err) {
      logger.warn('Failed to generate smart talking points via Gemini, using fallback', { error: err.message });
      return this._generateTalkingPointsFallback(cleanQuestion, activeSkill);
    }
  }

  _parseTalkingPoints(text) {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && (/^(\d+[\.\)]|[-•*])\s+/.test(l) || l.includes('[')));

    const extracted = [];
    for (const line of lines) {
      const cleaned = line.replace(/^(\d+[\.\)]|[-•*])\s*/, '').trim();
      if (cleaned.length > 3) {
        extracted.push(cleaned);
        if (extracted.length >= 3) break;
      }
    }
    return extracted;
  }

  _generateTalkingPointsFallback(questionText, activeSkill = 'interview') {
    const lower = questionText.toLowerCase();
    let p1 = 'Abordagem Direta: Definir o conceito principal e a arquitetura adotada';
    let p2 = 'Exemplo Prático: Ilustrar com um caso de uso real de produção';
    let p3 = 'Trade-offs: Discutir consistência, escalabilidade e pontos de atenção';

    if (lower.includes('kafka') || lower.includes('queue') || lower.includes('mensageria') || lower.includes('event')) {
      p1 = 'Abordagem: Explicar desacoplamento assíncrono com partitioning keys e tópicos';
      p2 = 'Produção: Garantir idempotência com correlation IDs e deduplicação';
      p3 = 'Trade-off: Ordem estrita por partição vs throughput horizontal';
    } else if (lower.includes('banco') || lower.includes('sql') || lower.includes('postgres') || lower.includes('database')) {
      p1 = 'Abordagem: Modelagem relacional com índices seletivos e particionamento';
      p2 = 'Otimização: Evitar N+1, usar pooling de conexões e cache read-through';
      p3 = 'Consistência: Níveis de isolamento ACID vs replicação eventual';
    } else if (lower.includes('algoritmo') || lower.includes('complexidade') || lower.includes('dsa') || lower.includes('array')) {
      p1 = 'Algoritmo: Identificar estrutura ótima para reduzir complexidade temporal';
      p2 = 'Complexidade: Apontar tempo O(n) ou O(log n) e espaço auxiliar O(1)';
      p3 = 'Edge cases: Tratar inputs vazios, limites de overflow e repetidos';
    } else if (lower.includes('desafio') || lower.includes('conflito') || lower.includes('erro') || lower.includes('falha')) {
      p1 = 'Situação: Apresentar o contexto com impacto de negócio sem culpar terceiros';
      p2 = 'Ação: Liderar resolução com análise de causa-raiz e testes contínuos';
      p3 = 'Resultado: Métrica de melhora obtida e aprendizado institucionalizado';
    }

    return {
      points: [p1, p2, p3],
      raw: `1. ${p1}\n2. ${p2}\n3. ${p3}`
    };
  }

  /**
   * Live Code Sentinel: analyzes coding problem or code snippet
   * and extracts critical edge cases, hidden traps, and complexity constraints.
   */
  async analyzeCornerCases(problemOrCode, programmingLanguage = null) {
    if (!problemOrCode || typeof problemOrCode !== 'string' || !problemOrCode.trim()) {
      return 'Nenhum código ou enunciado fornecido para análise de casos de borda.';
    }

    const cleanInput = problemOrCode.trim();
    const lang = programmingLanguage || 'general';

    const prompt = `Você é um especialista em algoritmos competitivos (Codeforces Grandmaster e LeetCode 3000+).
Analise o problema ou código abaixo (${lang}) e gere um alerta ultra-focado de CORNER CASES e ARMADILHAS OCULTAS que costumam quebrar soluções em entrevistas técnicas.

Problema / Código fornecido:
\`\`\`
${cleanInput.substring(0, 4000)}
\`\`\`

Formate sua resposta EXATAMENTE com a seguinte estrutura em Markdown:

### 🛡️ Corner Case Sentinel

#### ⚠️ Casos de Borda Críticos (Teste antes de submeter!)
- 🔴 **[Entrada Vazia / Mínima]**: (Ex: Array vazio [], string vazia "", N = 0 ou 1) -> Como lidar
- 🔴 **[Valores Extremos / Negativos]**: (Ex: Números negativos, zeros, duplicatas ou elementos todos iguais) -> Risco
- 🔴 **[Overflow & Tipagem]**: (Ex: Integer overflow > 2^31 - 1, usar 64-bit / long long, divisão por zero) -> Risco
- 🔴 **[Estruturas Cíclicas / Fronteiras]**: (Ex: Nós nulos, ciclos, matrizes não-quadradas, off-by-one) -> Risco
- 🔴 **[Escala & TLE]**: (Ex: Limite N = 10^5 exige O(N) ou O(N log N); O(N^2) dará Time Limit Exceeded)

#### 🎯 Alvo de Complexidade
- **Tempo Ótimo**: O(...)
- **Espaço Auxiliar**: O(...)

#### ⚡ Dica de Ouro de Implementação
(1 frase apontando o ponteiro, invariante de loop ou caso base que mais causa bugs).`;

    const request = {
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024
      }
    };

    try {
      return await this.executeRequest(request);
    } catch (err) {
      logger.error('Failed to analyze corner cases with LLM', { error: err.message });
      return `### 🛡️ Corner Case Sentinel (Checklist Rápido)\n\n- 🔴 **Array Vazio ou 1 Elemento**: Verifique se o loop inicial quebra.\n- 🔴 **Números Negativos e Zero**: Teste divisão e comparações.\n- 🔴 **Overflow Numérico**: Considere 64-bit se os valores acumularem.\n- 🔴 **Complexidade**: Se $N \\ge 10^5$, evite $O(N^2)$.\n\n*(Erro ao consultar LLM: ${err.message})*`;
    }
  }

  generateFallbackResponse(text, activeSkill) {
    logger.info('Generating fallback response', { activeSkill });

    const fallbackResponses = {
      'dsa': 'This appears to be a data structures and algorithms problem. Consider breaking it down into smaller components and identifying the appropriate algorithm or data structure to use.',
      'system-design': 'For this system design question, consider scalability, reliability, and the trade-offs between different architectural approaches.',
      'programming': 'This looks like a programming challenge. Focus on understanding the requirements, edge cases, and optimal time/space complexity.',
      'default': 'I can help analyze this content. Please ensure your Gemini API key is properly configured for detailed analysis.'
    };

    const response = fallbackResponses[activeSkill] || fallbackResponses.default;
    
    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true
      }
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    logger.info('Generating intelligent fallback response for transcription', { activeSkill });

    // Simple heuristic to determine if message seems skill-related
    const skillKeywords = {
      'dsa': ['algorithm', 'data structure', 'array', 'tree', 'graph', 'sort', 'search', 'complexity', 'big o'],
      'programming': ['code', 'function', 'variable', 'class', 'method', 'bug', 'debug', 'syntax'],
      'system-design': ['scalability', 'database', 'architecture', 'microservice', 'load balancer', 'cache'],
      'behavioral': ['interview', 'experience', 'situation', 'leadership', 'conflict', 'team'],
      'sales': ['customer', 'deal', 'negotiation', 'price', 'revenue', 'prospect'],
      'presentation': ['slide', 'audience', 'public speaking', 'presentation', 'nervous'],
      'data-science': ['data', 'model', 'machine learning', 'statistics', 'analytics', 'python', 'pandas'],
      'devops': ['deployment', 'ci/cd', 'docker', 'kubernetes', 'infrastructure', 'monitoring'],
      'negotiation': ['negotiate', 'compromise', 'agreement', 'terms', 'conflict resolution']
    };

    const textLower = text.toLowerCase();
    const relevantKeywords = skillKeywords[activeSkill] || [];
    const hasRelevantKeywords = relevantKeywords.some(keyword => textLower.includes(keyword));
    
    // Check for question indicators
    const questionIndicators = ['how', 'what', 'why', 'when', 'where', 'can you', 'could you', 'should i', '?'];
    const seemsLikeQuestion = questionIndicators.some(indicator => textLower.includes(indicator));

    let response;
    if (hasRelevantKeywords || seemsLikeQuestion) {
      response = `I'm having trouble processing that right now, but it sounds like a ${activeSkill} question. Could you rephrase or ask more specifically about what you need help with?`;
    } else {
      response = `Yeah, I'm listening. Ask your question relevant to ${activeSkill}.`;
    }
    
    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true
      }
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some(test => !test.success);
      
      if (hasNetworkIssues) {
        logger.warn('Network connectivity issues detected', networkCheck);
      }

      const generationConfig = this.getGenerationConfig({ temperature: 0, maxOutputTokens: 64 });
      const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
      const modelsToTry = [this.model, ...fallbackModels];

      let lastError = null;
      let result = null;
      let usedModel = null;

      for (const modelName of modelsToTry) {
        try {
          const startTime = Date.now();
          result = await this.client.models.generateContent({
            model: modelName,
            contents: 'Test connection. Please respond with "OK".',
            config: generationConfig
          });
          usedModel = modelName;
          const latency = Date.now() - startTime;
          const { text } = this.extractTextFromCandidates(result);

          logger.info('Connection test successful', {
            response: text,
            latency,
            model: usedModel,
            networkCheck: hasNetworkIssues ? 'issues_detected' : 'healthy'
          });

          return {
            success: true,
            response: text,
            latency,
            model: usedModel,
            networkConnectivity: networkCheck
          };
        } catch (error) {
          lastError = error;
          logger.warn(`Connection test failed for model ${modelName}`, {
            error: error.message,
            model: modelName
          });

          const isModelUnavailable = error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand') ||
            error.message.includes('quota') ||
            error.message.includes('rate limit');

          if (!isModelUnavailable && modelName === this.model) {
            // Primary model failed for a non-availability reason; don't hide it
            break;
          }
        }
      }

      throw lastError || new Error('Connection test failed on all models');
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', {
        error: error.message,
        errorAnalysis
      });

      // Map raw SDK errors to user-friendly messages. The wizard only
      // surfaces `error`, so any raw SDK error string would land in the
      // UI verbatim.
      const friendlyError = this._friendlyTestError(error, errorAnalysis);

      return {
        success: false,
        error: friendlyError,
        errorType: errorAnalysis?.type || 'UNKNOWN',
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(() => null)
      };
    }
  }

  /**
   * Translate raw SDK / network errors into something a user can act on.
   */
  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();

    if (type === 'NETWORK_ERROR' || raw.includes('fetch failed') || raw.includes('enotfound')) {
      return 'Cannot reach Google servers. Check your internet connection, firewall, or VPN settings.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
      return 'Invalid API key or insufficient permissions. Double-check the key at aistudio.google.com/apikey.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Rate limit or quota exceeded. Wait a moment or check your Google Cloud billing.';
    }
    if (type === 'TIMEOUT_ERROR') {
      return 'Request timed out. The Google API may be slow or unreachable right now.';
    }
    if (type === 'MODEL_ERROR' || raw.includes('model') || raw.includes('404')) {
      return 'The configured Gemini model is unavailable. Try a different model in Settings.';
    }
    if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
      return 'Gemini is experiencing high demand. Please wait a moment and try again.';
    }
    // Fall back to a stripped-down raw message (no SDK prefix noise)
    return (error?.message || 'Connection failed').replace(/^\[(GoogleGenerativeAI|GoogleGenAI) Error\]:\s*/i, '');
  }

  async testOpenRouterConnection(apiKeyOverride = null, modelOverride = null) {
    const apiKey = apiKeyOverride || config.getApiKey('OPENROUTER') || process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your-openrouter-key') {
      return { success: false, error: 'Chave do OpenRouter não configurada.' };
    }
    const model = modelOverride || config.get('llm.openrouter.model', 'deepseek/deepseek-r1:free');
    const startTime = Date.now();
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': config.get('llm.openrouter.siteUrl', 'https://github.com/TechyCSR/OpenCluely'),
          'X-Title': config.get('llm.openrouter.siteName', 'OpenCluely'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Responda apenas: OK' }],
          max_tokens: 16
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `OpenRouter HTTP ${response.status}: ${errText.slice(0, 150)}` };
      }

      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || 'OK';
      return {
        success: true,
        latency: Date.now() - startTime,
        model,
        response: text.trim()
      };
    } catch (err) {
      return { success: false, error: `Falha ao conectar com OpenRouter: ${err.message}` };
    }
  }

  async testOllamaConnection(baseUrlOverride = null, modelOverride = null) {
    const baseUrl = baseUrlOverride || config.get('llm.ollama.baseUrl', 'http://localhost:11434');
    const model = modelOverride || config.get('llm.ollama.model', 'llama3.2:3b');
    const startTime = Date.now();
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Responda apenas: OK' }],
          max_tokens: 16
        })
      });

      if (!response.ok) {
        return { success: false, error: `Ollama HTTP ${response.status}` };
      }

      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || 'OK';
      return {
        success: true,
        latency: Date.now() - startTime,
        model,
        response: text.trim()
      };
    } catch (err) {
      return { success: false, error: `Não foi possível conectar ao Ollama em ${baseUrl}: ${err.message}` };
    }
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();
    
    logger.info('API key updated and client reinitialized');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      config: config.get('llm.gemini'),
      providerStats: this.providerStats,
      circuitBreaker: {
        geminiFailures: this.circuitBreaker.geminiFailures,
        isTripped: this.circuitBreaker.geminiTrippedUntil > Date.now(),
        trippedUntil: this.circuitBreaker.geminiTrippedUntil
      }
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async executeAlternativeRequest(geminiRequest) {
    const https = require('https');
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = config.get('llm.gemini.model');
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.info('Using alternative HTTPS request method', { modelsToTry });

    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        const result = await this._executeAlternativeRequestForModel(geminiRequest, modelName, apiKey);
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(`Alternative HTTPS request failed for model ${modelName}`, {
          error: error.message,
          model: modelName
        });

        const isModelUnavailable = error.message.includes('503') ||
          error.message.includes('UNAVAILABLE') ||
          error.message.includes('high demand');

        if (!isModelUnavailable && modelName === primaryModel) {
          break;
        }
      }
    }

    throw lastError || new Error('Alternative HTTPS request failed for all models');
  }

  async _executeAlternativeRequestForModel(geminiRequest, modelName, apiKey) {
    const https = require('https');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const postData = JSON.stringify(geminiRequest);

    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout: config.get('llm.gemini.timeout'),
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            
            const response = JSON.parse(data);
            
            logger.debug('Alternative request response structure', {
              hasResponse: !!response,
              hasCandidates: !!response.candidates,
              candidatesLength: response.candidates?.length,
              responseKeys: Object.keys(response || {}),
              firstCandidateKeys: response.candidates?.[0] ? Object.keys(response.candidates[0]) : []
            });

            const { text, finishReason } = this.extractTextFromCandidates(response);

            if (finishReason === 'MAX_TOKENS') {
              logger.warn('Gemini alternative response reached max tokens limit', {
                finishReason
              });
            }
            
            logger.info('Alternative request successful', {
              responseLength: text.length,
              statusCode: res.statusCode,
              finishReason
            });
            
            resolve(text.trim());
          } catch (parseError) {
            logger.error('Failed to parse alternative response', {
              error: parseError.message,
              rawResponse: data.substring(0, 500),
              statusCode: res.statusCode
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`Alternative request failed: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Alternative request timeout'));
      });
      
      req.write(postData);
      req.end();
    });
  }
}

const llmServiceInstance = new LLMService();
llmServiceInstance.LLMService = LLMService;
module.exports = llmServiceInstance;

