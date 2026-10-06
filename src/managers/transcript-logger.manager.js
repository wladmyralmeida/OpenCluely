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
    this.lastSessionFilePath = null;
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
    this.lastSessionFilePath = savedFile;
    this.currentFilePath = null;
    return savedFile;
  }

  /**
   * Save a meeting summary to disk alongside the transcript file
   * @param {string} fileNameOrPath - Target transcript file path or name
   * @param {string} summaryText - Generated meeting summary (Markdown)
   * @returns {string|null} Path to the saved summary markdown file
   */
  saveTranscriptSummary(fileNameOrPath, summaryText) {
    if (!summaryText || !summaryText.trim()) return null;
    this._ensureDirExists();

    const targetPath = path.isAbsolute(fileNameOrPath)
      ? fileNameOrPath
      : path.join(this.transcriptsDir, fileNameOrPath);

    const summaryPath = targetPath.endsWith('_summary.md')
      ? targetPath
      : targetPath.replace(/\.txt$/, '_summary.md');

    try {
      fs.writeFileSync(summaryPath, summaryText.trim() + '\n', 'utf8');
      logger.info('Saved meeting transcript summary file', { summaryPath });

      // Also append summary to original .txt transcript if it exists
      if (fs.existsSync(targetPath) && targetPath.endsWith('.txt')) {
        const existing = fs.readFileSync(targetPath, 'utf8');
        const summaryHeader = '\n================================================================================\nMEETING SUMMARY (RESUMO DA REUNIÃO)\n================================================================================\n\n';
        if (!existing.includes('MEETING SUMMARY (RESUMO DA REUNIÃO)')) {
          fs.appendFileSync(targetPath, summaryHeader + summaryText.trim() + '\n\n', 'utf8');
        }
      }

      return summaryPath;
    } catch (err) {
      logger.error('Failed to save meeting summary', { error: err.message, summaryPath });
      return null;
    }
  }

  /**
   * Read meeting summary for a transcript file
   * @param {string} fileNameOrPath - Transcript file name or path
   * @returns {string|null} Summary text or null
   */
  getTranscriptSummary(fileNameOrPath) {
    try {
      const targetPath = path.isAbsolute(fileNameOrPath)
        ? fileNameOrPath
        : path.join(this.transcriptsDir, fileNameOrPath);

      const summaryPath = targetPath.endsWith('_summary.md')
        ? targetPath
        : targetPath.replace(/\.txt$/, '_summary.md');

      if (fs.existsSync(summaryPath)) {
        return fs.readFileSync(summaryPath, 'utf8');
      }

      if (fs.existsSync(targetPath)) {
        const content = fs.readFileSync(targetPath, 'utf8');
        const marker = 'MEETING SUMMARY (RESUMO DA REUNIÃO)\n================================================================================\n\n';
        const markerIdx = content.indexOf(marker);
        if (markerIdx !== -1) {
          return content.substring(markerIdx + marker.length).trim();
        }
      }
    } catch (err) {
      logger.error('Failed to read meeting summary', { error: err.message });
    }
    return null;
  }

  /**
   * Get list of all saved call transcript files with summary metadata
   */
  listTranscripts() {
    this._ensureDirExists();
    try {
      const files = fs.readdirSync(this.transcriptsDir);
      return files
        .filter(f => f.startsWith('call-transcript') && f.endsWith('.txt'))
        .map(f => {
          const fullPath = path.join(this.transcriptsDir, f);
          const stat = fs.statSync(fullPath);
          const summaryPath = path.join(this.transcriptsDir, f.replace(/\.txt$/, '_summary.md'));
          const hasSummary = fs.existsSync(summaryPath);
          return {
            name: f,
            path: fullPath,
            sizeBytes: stat.size,
            createdAt: stat.birthtime || stat.mtime,
            updatedAt: stat.mtime,
            hasSummary,
            summaryPath: hasSummary ? summaryPath : null
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

  /**
   * Get path of the most recently finished or active session
   */
  getLastSessionFilePath() {
    if (this.currentFilePath && fs.existsSync(this.currentFilePath)) {
      return this.currentFilePath;
    }
    if (this.lastSessionFilePath && fs.existsSync(this.lastSessionFilePath)) {
      return this.lastSessionFilePath;
    }
    const transcripts = this.listTranscripts();
    return transcripts.length > 0 ? transcripts[0].path : null;
  }
}

module.exports = new TranscriptLoggerManager();
