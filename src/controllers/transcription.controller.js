const logger = require('../core/logger').createServiceLogger('TRANSCRIPTION_CTRL');

class TranscriptionController {
  constructor({ appController, windowManager, speechService, sessionManager, llmService, captureService }) {
    this.appController = appController;
    this.windowManager = windowManager;
    this.speechService = speechService;
    this.sessionManager = sessionManager;
    this.llmService = llmService;
    this.captureService = captureService;

    this.utteranceBuffer = "";
    this.utteranceTimer = null;
    this.utteranceDispatchInFlight = false;
    this.utteranceCoalesceMs = 150;
    this.responseSeq = 0;
  }

  resetBuffer() {
    if (this.utteranceTimer) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    this.utteranceBuffer = "";
    this.utteranceDispatchInFlight = false;
  }

  get activeSkill() {
    return this.appController.activeSkill;
  }

  get codingLanguage() {
    return this.appController.codingLanguage;
  }

  get speechModeGeneration() {
    return this.appController._speechModeGeneration;
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce.
   */
  handleTranscriptionFragment(text) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Route speech UI events according to the user's response-target setting.
    this.sessionManager.addUserInput(fragment, 'speech');
    const transcriptionOnly = this.activeSkill === "transcript";
    if (transcriptionOnly) {
      this.sendToChatWindow("transcription-received", { text: fragment, transcriptionOnly: true });
      if (this.shouldShowVoiceOverlay()) {
        this.windowManager.showLLMResponse(fragment, {
          skill: 'transcript',
          isTranscriptionOnly: true
        });
      }
      return;
    }
    this.sendToVoiceResponseWindows("transcription-received", { text: fragment, transcriptionOnly: false });

    this.utteranceBuffer = this.utteranceBuffer
      ? `${this.utteranceBuffer} ${fragment}`
      : fragment;

    if (this.utteranceTimer) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (this.speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this.utteranceTimer = setTimeout(() => {
      this.utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this.utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM.
   */
  async dispatchCoalescedUtterance() {
    if (this.activeSkill === "transcript") {
      this.utteranceBuffer = "";
      return;
    }
    if (this.utteranceDispatchInFlight) {
      return;
    }
    const combined = this.utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this.utteranceBuffer = "";
    this.utteranceDispatchInFlight = true;
    const generation = this.speechModeGeneration;

    try {
      const sessionHistory = this.sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory, generation);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      if (generation === this.speechModeGeneration) {
        this.utteranceDispatchInFlight = false;
        // Anything that arrived while we were busy gets answered now.
        if (this.utteranceBuffer.trim()) {
          this.dispatchCoalescedUtterance();
        }
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory, generation = this.speechModeGeneration) {
    if (this.activeSkill === "transcript" || generation !== this.speechModeGeneration) {
      return;
    }
    const responseSkill = this.activeSkill;
    const isCurrentMode = () => generation === this.speechModeGeneration && this.activeSkill === responseSkill;
    let messageId = null;

    try {
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this.responseSeq = (this.responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this.responseSeq}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      if (this.shouldShowVoiceOverlay()) {
        this.windowManager.showLLMLoading();
      }
      const llmResult = await this.llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        responseSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          if (!isCurrentMode()) return;
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      if (!isCurrentMode()) return;
      llmResult.metadata = { ...llmResult.metadata, messageId };

      this.sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      this.sendTranscriptionLLMResponseToVoiceTargets(llmResult);
      if (this.shouldShowVoiceOverlay()) {
        this.windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isTranscriptionResponse: true
        });
      }

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      if (!isCurrentMode()) return;
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      try {
        const fallbackResult = this.llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        this.sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.sendTranscriptionLLMResponseToVoiceTargets(fallbackResult);
        if (this.shouldShowVoiceOverlay()) {
          this.windowManager.showLLMResponse(fallbackResult.response, {
            skill: this.activeSkill,
            processingTime: fallbackResult.metadata.processingTime,
            usedFallback: true,
            isTranscriptionResponse: true
          });
        }
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        this.sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  async processWithLLM(text, sessionHistory) {
    if (this.activeSkill === "transcript") {
      return;
    }
    const generation = this.speechModeGeneration;
    try {
      this.sessionManager.addUserInput(text, 'llm_input');
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this.responseSeq = (this.responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this.responseSeq}`;
      this.windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      this.windowManager.showLLMLoading();

      const llmResult = await this.llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          if (generation !== this.speechModeGeneration) return;
          this.windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      if (generation !== this.speechModeGeneration) return;
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      this.sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      this.windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });
    } catch (error) {
      if (generation !== this.speechModeGeneration) return;
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      this.windowManager.hideLLMResponse();
      this.sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  async triggerScreenshotOCR() {
    if (this.activeSkill === "transcript") {
      return;
    }
    const generation = this.speechModeGeneration;
    if (!this.appController.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      this.windowManager.showLLMLoading();

      const capture = await this.captureService.captureAndProcess();
      if (generation !== this.speechModeGeneration) return;

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        this.windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      const sessionHistory = this.sessionManager.getOptimizedHistory();
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this.responseSeq = (this.responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this.responseSeq}`;
      this.windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await this.llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          if (generation !== this.speechModeGeneration) return;
          this.windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      if (generation !== this.speechModeGeneration) return;
      llmResult.metadata = { ...llmResult.metadata, messageId };

      this.sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      this.windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });
    } catch (error) {
      if (generation !== this.speechModeGeneration) return;
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      this.windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      this.sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  broadcastOCRSuccess(ocrResult) {
    this.windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    this.windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill,
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    this.windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    this.windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    this.windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  sendToChatWindow(channel, data) {
    const chatWindow = this.windowManager.getWindow("chat");
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.warn("Chat window unavailable for speech event", { channel });
      return;
    }
    chatWindow.webContents.send(channel, data);
  }

  getVoiceResponseTarget() {
    const configured = String(process.env.WHISPER_RESPONSE_TARGET || 'both').trim().toLowerCase();
    return ['chat', 'overlay', 'both'].includes(configured) ? configured : 'both';
  }

  shouldShowVoiceOverlay() {
    return ['overlay', 'both'].includes(this.getVoiceResponseTarget());
  }

  sendToVoiceResponseWindows(channel, data) {
    const target = this.getVoiceResponseTarget();
    if (target === 'chat' || target === 'both') {
      this.sendToChatWindow(channel, data);
    }
    if (target === 'overlay' || target === 'both') {
      const responseWindow = this.windowManager.getWindow("llmResponse");
      if (responseWindow && !responseWindow.isDestroyed()) {
        responseWindow.webContents.send(channel, data);
      }
    }
  }

  sendTranscriptionLLMResponseToVoiceTargets(llmResult) {
    const data = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };
    this.sendToVoiceResponseWindows("transcription-llm-response", data);
  }
}

module.exports = TranscriptionController;
