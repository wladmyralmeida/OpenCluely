const { globalShortcut } = require('electron');
const logger = require('../core/logger').createServiceLogger('SHORTCUT');

class ShortcutController {
  constructor({ appController, windowManager, speechService, sessionManager, availableSkills }) {
    this.appController = appController;
    this.windowManager = windowManager;
    this.speechService = speechService;
    this.sessionManager = sessionManager;
    this.availableSkills = availableSkills || ["interview", "dsa", "transcript"];
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.appController.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => this.windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => this.windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => this.windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => this.windowManager.showSettings(),
      "Alt+A": () => this.windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => this.windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = this.windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof this.speechService.isAvailable === 'function' 
      ? this.speechService.isAvailable() 
      : !!this.speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        this.windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        this.windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = this.speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        this.speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        this.speechService.startRecording();
        this.windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      this.sessionManager.clear();
      this.windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = this.windowManager.getWindowStats().isInteractive;
    if (isInteractive) {
      this.navigateSkill(-1);
    } else {
      this.windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = this.windowManager.getWindowStats().isInteractive;
    if (isInteractive) {
      this.navigateSkill(1);
    } else {
      this.windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = this.windowManager.getWindowStats().isInteractive;
    if (!isInteractive) {
      this.windowManager.moveBoundWindows(-20, 0);
    }
  }

  handleRightArrow() {
    const isInteractive = this.windowManager.getWindowStats().isInteractive;
    if (!isInteractive) {
      this.windowManager.moveBoundWindows(20, 0);
    }
  }

  navigateSkill(direction) {
    const currentIndex = this.availableSkills.indexOf(this.appController.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.appController.activeSkill,
        availableSkills: this.availableSkills,
      });
      return;
    }

    let newIndex = currentIndex + direction;
    if (newIndex >= this.availableSkills.length) {
      newIndex = 0;
    } else if (newIndex < 0) {
      newIndex = this.availableSkills.length - 1;
    }

    const newSkill = this.availableSkills[newIndex];
    this.appController.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: this.availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });
  }
}

module.exports = ShortcutController;
