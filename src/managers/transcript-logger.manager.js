const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../core/logger').createServiceLogger('TRANSCRIPT_LOGGER');
const config = require('../core/config');

class TranscriptLoggerManager {
  constructor() {
    this.currentFilePath = null;
    this.sessionStartTime = null;
    this.currentSkill = 'interview';
    this.entryCount = 0;
    this.wordCount = 0;
    this.transcriptsDir = this._resolveTranscriptsDir();
    this._ensureDirExists();
  }

  _resolveTranscriptsDir() {
    try {
      const electron = require('electron');
      const app = electron.app || electron.remote?.app;
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'transcripts');
      }
    } catch (_) {}
    return path.join(os.homedir(), '.OpenCluely', 'transcripts');
  }

  _ensureDirExists() {
    try {
      if (!fs.existsSync(this.transcriptsDir)) {
        fs.mkdirSync(this.transcriptsDir, { recursive: true });
      }
    } catch (err) {
      logger.error('Failed to create transcripts directory', { error: err.message });
    }
  }

  /**
   * Start a new call transcript session file
   * @param {string} skill - Current active skill
   */
  startSession(skill = 'interview') {
    this._ensureDirExists();
    this.currentSkill = skill;
    this.sessionStartTime = new Date();
    this.entryCount = 0;
    this.wordCount = 0;

    const pad = (n) => String(n).padStart(2, '0');
    const y = this.sessionStartTime.getFullYear();
    const m = pad(this.sessionStartTime.getMonth() + 1);
    const d = pad(this.sessionStartTime.getDate());
    const hh = pad(this.sessionStartTime.getHours());
    const mm = pad(this.sessionStartTime.getMinutes());
    const ss = pad(this.sessionStartTime.getSeconds());

    const fileName = `call-transcript_${y}-${m}-${d}_${hh}-${mm}-${ss}.txt`;
    this.currentFilePath = path.join(this.transcriptsDir, fileName);

    const header = [
      '================================================================================',
      `OpenCluely - Call Transcript`,
      `Session Date: ${this.sessionStartTime.toISOString().replace('T', ' ').substring(0, 19)}`,
      `Mode / Skill: ${skill.toUpperCase()}`,
      '================================================================================\n\n'
    ].join('\n');

    try {
      fs.writeFileSync(this.currentFilePath, header, 'utf8');
      logger.info('Call transcript session started', { file: this.currentFilePath });
    } catch (err) {
      logger.error('Failed to initialize call transcript file', { error: err.message });
    }

    return this.currentFilePath;
  }

  /**
   * Log spoken audio / transcription fragment
   * @param {string} text - Spoken text
   * @param {string} speaker - Speaker identifier
   */
  logSpeech(text, speaker = 'SPEAKER') {
    if (!text || !text.trim()) return;
    if (!this.currentFilePath) {
      this.startSession(this.currentSkill);
    }

    const clean = text.trim();
    const timeStr = new Date().toTimeString().split(' ')[0];
    const words = clean.split(/\s+/).filter(Boolean).length;
    this.wordCount += words;
    this.entryCount++;

    const line = `[${timeStr}] [${speaker}] ${clean}\n\n`;

    try {
      fs.appendFileSync(this.currentFilePath, line, 'utf8');
      logger.debug('Speech logged to call transcript', { words, entryCount: this.entryCount });
    } catch (err) {
      logger.error('Failed to append speech to call transcript', { error: err.message });
    }
  }

  /**
   * Log AI response if enabled in config
   * @param {string} responseText - LLM response text
   */
  logAIResponse(responseText) {
    if (config.get('transcripts.includeAIResponses', true) === false) return;
    if (!responseText || !responseText.trim()) return;
    if (!this.currentFilePath) {
      this.startSession(this.currentSkill);
    }

    const clean = responseText.trim();
    const timeStr = new Date().toTimeString().split(' ')[0];
    const line = `[${timeStr}] [AI ASSISTANT]\n${clean}\n\n`;

    try {
      fs.appendFileSync(this.currentFilePath, line, 'utf8');
      logger.debug('AI response logged to call transcript');
    } catch (err) {
      logger.error('Failed to append AI response to call transcript', { error: err.message });
    }
  }

  /**
   * End current transcript session with summary footer
   */
  endSession() {
    if (!this.currentFilePath || !fs.existsSync(this.currentFilePath)) {
      return null;
    }

    const endTime = new Date();
    const durationSec = this.sessionStartTime ? Math.round((endTime - this.sessionStartTime) / 1000) : 0;
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;

    const footer = [
      '--------------------------------------------------------------------------------',
      `Session Ended: ${endTime.toISOString().replace('T', ' ').substring(0, 19)}`,
      `Duration: ${minutes}m ${seconds}s`,
      `Total Utterances Logged: ${this.entryCount}`,
      `Total Words Spoken: ${this.wordCount}`,
      '================================================================================\n'
    ].join('\n');

    try {
      fs.appendFileSync(this.currentFilePath, footer, 'utf8');
      logger.info('Call transcript session ended', {
        file: this.currentFilePath,
        duration: `${durationSec}s`,
        totalEntries: this.entryCount
      });
    } catch (err) {
      logger.error('Failed to finalize call transcript file', { error: err.message });
    }

    const savedFile = this.currentFilePath;
    this.currentFilePath = null;
    return savedFile;
  }

  /**
   * Get list of all saved call transcript files
   */
  listTranscripts() {
    this._ensureDirExists();
    try {
      const files = fs.readdirSync(this.transcriptsDir);
      return files
        .filter(f => f.startsWith('call-transcript') && (f.endsWith('.txt') || f.endsWith('.md')))
        .map(f => {
          const fullPath = path.join(this.transcriptsDir, f);
          const stat = fs.statSync(fullPath);
          return {
            name: f,
            path: fullPath,
            sizeBytes: stat.size,
            createdAt: stat.birthtime || stat.mtime,
            updatedAt: stat.mtime
          };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (err) {
      logger.error('Failed to list transcripts', { error: err.message });
      return [];
    }
  }

  /**
   * Read transcript content
   */
  getTranscriptContent(fileNameOrPath) {
    try {
      const targetPath = path.isAbsolute(fileNameOrPath)
        ? fileNameOrPath
        : path.join(this.transcriptsDir, fileNameOrPath);
      
      if (fs.existsSync(targetPath)) {
        return fs.readFileSync(targetPath, 'utf8');
      }
    } catch (err) {
      logger.error('Failed to read transcript file', { error: err.message });
    }
    return null;
  }

  /**
   * Get current active file path
   */
  getCurrentFilePath() {
    return this.currentFilePath;
  }
}

module.exports = new TranscriptLoggerManager();
