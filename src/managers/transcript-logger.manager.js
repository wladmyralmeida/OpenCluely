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
  startSession(skillOrOptions = 'interview') {
    this._ensureDirExists();
    const skillName = typeof skillOrOptions === 'string'
      ? skillOrOptions
      : (skillOrOptions?.skill || skillOrOptions?.mode || 'interview');
    this.currentSkill = skillName;
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
      `Mode / Skill: ${skillName.toUpperCase()}`,
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

  _extractTranscriptMetadata(content) {
    if (!content) return {};
    const skillMatch = content.match(/Mode \/ Skill:\s*([^\n\r]+)/i);
    const dateMatch = content.match(/Session Date:\s*([^\n\r]+)/i);
    const durationMatch = content.match(/Duration:\s*([^\n\r]+)/i);
    const utterancesMatch = content.match(/Total Utterances Logged:\s*(\d+)/i);
    const wordsMatch = content.match(/Total Words Spoken:\s*(\d+)/i);

    // Detect speakers
    const speakers = new Set();
    const speakerMatches = content.match(/\[(VOCÊ|VOCE|ENTREVISTADOR|CANDIDATO|SPEAKER|AI ASSISTANT)\]/g) || [];
    for (const sm of speakerMatches) {
      const clean = sm.replace(/[\[\]]/g, '');
      speakers.add(clean === 'VOCE' ? 'VOCÊ' : clean);
    }

    // Extract first spoken lines for preview
    const spokenLines = [];
    const lines = content.split('\n');
    for (const l of lines) {
      if (l.startsWith('[') && (l.includes('[SPEAKER]') || l.includes('[VOCÊ]') || l.includes('[ENTREVISTADOR]') || l.includes('[CANDIDATO]'))) {
        spokenLines.push(l.trim());
        if (spokenLines.length >= 2) break;
      }
    }

    return {
      skill: skillMatch ? skillMatch[1].trim() : 'INTERVIEW',
      sessionDate: dateMatch ? dateMatch[1].trim() : null,
      duration: durationMatch ? durationMatch[1].trim() : null,
      utteranceCount: utterancesMatch ? parseInt(utterancesMatch[1], 10) : spokenLines.length,
      wordCount: wordsMatch ? parseInt(wordsMatch[1], 10) : null,
      speakers: Array.from(speakers),
      preview: spokenLines.join(' • ')
    };
  }

  /**
   * Get list of all saved call transcript files with rich summary and speaker metadata
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

          let meta = {};
          let summaryPreview = null;
          try {
            const txtSnippet = fs.readFileSync(fullPath, 'utf8');
            meta = this._extractTranscriptMetadata(txtSnippet);

            if (hasSummary) {
              const sumContent = fs.readFileSync(summaryPath, 'utf8');
              summaryPreview = sumContent.replace(/^#+.*?\n/gm, '').trim().substring(0, 180);
            }
          } catch (_) {}

          return {
            name: f,
            path: fullPath,
            sizeBytes: stat.size,
            createdAt: stat.birthtime || stat.mtime,
            updatedAt: stat.mtime,
            hasSummary,
            summaryPath: hasSummary ? summaryPath : null,
            summaryPreview,
            ...meta
          };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch (err) {
      logger.error('Failed to list transcripts', { error: err.message });
      return [];
    }
  }

  /**
   * Delete transcript file and associated summary file
   * @param {string} fileNameOrPath
   */
  deleteTranscript(fileNameOrPath) {
    try {
      const targetPath = path.isAbsolute(fileNameOrPath)
        ? fileNameOrPath
        : path.join(this.transcriptsDir, fileNameOrPath);

      const summaryPath = targetPath.replace(/\.txt$/, '_summary.md');

      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      if (fs.existsSync(summaryPath)) {
        fs.unlinkSync(summaryPath);
      }

      logger.info('Deleted transcript file and associated summary', { targetPath });
      return { success: true, fileName: path.basename(targetPath) };
    } catch (err) {
      logger.error('Failed to delete transcript', { error: err.message });
      return { success: false, error: err.message };
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

  /**
   * Extract action items from summary and transcript
   * @param {string} summaryText
   * @param {string} transcriptText
   * @returns {{ checklistMarkdown: string, items: string[] }}
   */
  extractActionItems(summaryText = '', transcriptText = '') {
    const items = [];
    const seen = new Set();

    const addItem = (raw) => {
      if (!raw) return;
      const clean = raw
        .replace(/^[-*•]\s*/, '')
        .replace(/^\[[\sxX]\]\s*/, '')
        .replace(/^\*\*\[.*?\]\*\*:\s*/, '')
        .replace(/^\*\*.*?\*\*:\s*/, '')
        .trim();
      if (clean.length > 5 && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        items.push(clean);
      }
    };

    // 1. Search inside summary for action items section
    if (summaryText) {
      // Direct checkbox lines anywhere in summary
      const checkboxMatches = summaryText.match(/^[-*•]\s*\[[\sxX]\]\s*(.+)$/gm) || [];
      for (const cb of checkboxMatches) {
        addItem(cb);
      }

      // Action items section
      const actionSectionMatch = summaryText.match(/##[^\n\r]*(?:Próximos Passos|Ações|Action Items|Decisões)[^\n\r]*\n([\s\S]*?)(?=\n##|$)/i);
      if (actionSectionMatch && actionSectionMatch[1]) {
        const lines = actionSectionMatch[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.startsWith('•') || /^\d+\./.test(trimmed)) {
            addItem(trimmed);
          }
        }
      }
    }

    // 2. Search inside transcript for speech action items
    if (transcriptText) {
      const lines = transcriptText.split('\n');
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (
          lower.includes('action item:') ||
          lower.includes('combinado:') ||
          lower.includes('ficou combinado') ||
          lower.includes('vou ') ||
          lower.includes('iremos ') ||
          lower.includes('will ')
        ) {
          const cleanedLine = line.replace(/^\[.*?\]\s*\[.*?\]\s*/, '').trim();
          if (cleanedLine.length > 10) {
            addItem(cleanedLine);
          }
        }
      }
    }

    // 3. Fallback defaults if no explicit action items found
    if (items.length === 0) {
      items.push('Revisar anotações técnicas e pontos-chave discutidos na sessão');
      items.push('Dar andamento aos alinhamentos e decisões estabelecidas');
      items.push('Agendar follow-up ou enviar resumo para os participantes se necessário');
    }

    const checklistMarkdown = items.map(it => `- [ ] ${it}`).join('\n');
    return { checklistMarkdown, items };
  }

  /**
   * Extract action items from a transcript file or session
   */
  extractActionItemsFromTranscript(fileNameOrPath) {
    const target = fileNameOrPath || this.getLastSessionFilePath();
    if (!target) return { checklistMarkdown: '', items: [] };

    const transcriptContent = this.getTranscriptContent(target) || '';
    const summaryContent = this.getTranscriptSummary(target) || '';
    return this.extractActionItems(summaryContent, transcriptContent);
  }

  /**
   * Generate ready-to-paste Notion / Slack / Obsidian template
   * @param {string} fileNameOrPath
   * @returns {string} Markdown template
   */
  generateNotionSlackTemplate(fileNameOrPath) {
    const target = fileNameOrPath || this.getLastSessionFilePath();
    if (!target) return '# Ata de Reunião\n\nNenhuma reunião selecionada.';

    const transcriptContent = this.getTranscriptContent(target) || '';
    const summaryContent = this.getTranscriptSummary(target) || '';
    const meta = this._extractTranscriptMetadata(transcriptContent);
    const { checklistMarkdown } = this.extractActionItems(summaryContent, transcriptContent);

    const title = meta.sessionDate ? `Ata de Reunião: ${meta.sessionDate}` : `Ata: ${path.basename(target, '.txt')}`;
    const duration = meta.duration || 'N/A';
    const skill = meta.skill || 'INTERVIEW';
    const speakers = (meta.speakers && meta.speakers.length > 0) ? meta.speakers.join(', ') : 'VOCÊ, ENTREVISTADOR';
    const words = meta.wordCount ? `${meta.wordCount} palavras` : (meta.utteranceCount ? `${meta.utteranceCount} falas` : 'N/A');

    // Cleaned summary body without the main h1
    const cleanSummary = summaryContent
      ? summaryContent.replace(/^#\s+[^\n]+\n+/, '').trim()
      : meta.preview || 'Transcrição gravada localmente.';

    return `# 📋 ${title}
> ⏱️ **Duração**: ${duration} &nbsp;|&nbsp; 👥 **Participantes**: ${speakers} &nbsp;|&nbsp; 🎯 **Skill**: ${skill} &nbsp;|&nbsp; 📝 **Volume**: ${words}

---

## 🎯 Resumo Executivo
${cleanSummary}

---

## ✅ Checklist de Ações & Próximos Passos
${checklistMarkdown}

---
*Exportado com 1-Clique via **OpenCluely** • Transcrição Local & Privada em ~/.OpenCluely/transcripts*`;
  }

  /**
   * Generate a print-ready Executive HTML document (for PDF export and rendering)
   * @param {string} fileNameOrPath
   * @returns {string} Self-contained HTML report
   */
  generateExecutiveHtmlReport(fileNameOrPath) {
    const target = fileNameOrPath || this.getLastSessionFilePath();
    const transcriptContent = this.getTranscriptContent(target) || '';
    const summaryContent = this.getTranscriptSummary(target) || '';
    const meta = this._extractTranscriptMetadata(transcriptContent);
    const { items: actionItems } = this.extractActionItems(summaryContent, transcriptContent);

    const title = meta.sessionDate ? `Relatório Executivo: ${meta.sessionDate}` : `Relatório: ${path.basename(target, '.txt')}`;
    const duration = meta.duration || '0m';
    const skill = meta.skill || 'INTERVIEW';
    const speakers = (meta.speakers && meta.speakers.length > 0) ? meta.speakers : ['VOCÊ', 'ENTREVISTADOR'];

    // Format action checklist HTML
    const actionChecklistHtml = actionItems.map(it => `
      <div class="checklist-item">
        <span class="checkbox-box">☐</span>
        <span class="checklist-text">${escapeHtml(it)}</span>
      </div>
    `).join('');

    // Format transcript turns with dialogue badges
    const lines = transcriptContent.split('\n');
    const dialogueHtml = lines
      .map(l => l.trim())
      .filter(l => l.startsWith('[') && (l.includes('[VOCÊ]') || l.includes('[ENTREVISTADOR]') || l.includes('[SPEAKER]') || l.includes('[AI ASSISTANT]')))
      .map(l => {
        const match = l.match(/^\[(.*?)\]\s*\[(.*?)\]\s*(.*)$/);
        if (match) {
          const [, time, speaker, text] = match;
          const isInterviewer = speaker.includes('ENTREVISTADOR') || speaker.includes('SYSTEM');
          const isUser = speaker.includes('VOCÊ') || speaker.includes('VOCE');
          const badgeClass = isInterviewer ? 'badge-interviewer' : (isUser ? 'badge-user' : 'badge-default');
          return `
            <div class="turn-row">
              <span class="turn-time">${escapeHtml(time)}</span>
              <span class="turn-speaker ${badgeClass}">${escapeHtml(speaker)}</span>
              <span class="turn-text">${escapeHtml(text)}</span>
            </div>
          `;
        }
        return `<div class="turn-row"><span class="turn-text">${escapeHtml(l)}</span></div>`;
      })
      .join('');

    // Clean summary into readable paragraphs
    const formattedSummaryHtml = summaryContent
      ? summaryContent
          .replace(/^#+.*?\n/gm, '')
          .split('\n\n')
          .filter(p => p.trim())
          .map(p => `<p>${escapeHtml(p.trim())}</p>`)
          .join('')
      : `<p>${escapeHtml(meta.preview || 'Nenhum resumo gerado.')}</p>`;

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      size: A4;
      margin: 16mm 14mm 16mm 14mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1a1a24;
      background: #ffffff;
      margin: 0;
      padding: 24px;
      line-height: 1.5;
      font-size: 13px;
    }
    .header-banner {
      border-bottom: 2px solid #7c4dff;
      padding-bottom: 14px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .brand-title {
      font-size: 20px;
      font-weight: 800;
      color: #1a1a24;
      letter-spacing: -0.5px;
    }
    .brand-badge {
      font-size: 10px;
      font-weight: 700;
      background: #7c4dff;
      color: #fff;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: inline-block;
      margin-bottom: 4px;
    }
    .header-subtitle {
      font-size: 12px;
      color: #666;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 22px;
    }
    .meta-card {
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 6px;
      padding: 10px 12px;
    }
    .meta-card-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: #868e96;
      margin-bottom: 2px;
    }
    .meta-card-value {
      font-size: 14px;
      font-weight: 700;
      color: #212529;
    }
    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: #212529;
      border-bottom: 1px solid #dee2e6;
      padding-bottom: 6px;
      margin-top: 22px;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .summary-box {
      background: #fdfbf7;
      border-left: 4px solid #7c4dff;
      border: 1px solid #e9d5ff;
      border-left-width: 4px;
      border-radius: 6px;
      padding: 14px 16px;
      font-size: 13px;
      color: #333;
      margin-bottom: 20px;
    }
    .summary-box p { margin: 0 0 10px 0; }
    .summary-box p:last-child { margin-bottom: 0; }
    .checklist-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 22px;
    }
    .checklist-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      padding: 8px 12px;
      border-radius: 5px;
    }
    .checkbox-box {
      font-size: 16px;
      color: #7c4dff;
      line-height: 1;
      font-weight: bold;
    }
    .checklist-text {
      font-size: 12px;
      color: #343a40;
    }
    .dialogue-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .turn-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 10px;
      border-radius: 4px;
      background: #fcfcfc;
      border: 1px solid #f1f3f5;
    }
    .turn-time {
      font-family: monospace;
      font-size: 10px;
      color: #868e96;
      width: 55px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .turn-speaker {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      flex-shrink: 0;
      width: 105px;
      text-align: center;
    }
    .badge-user {
      background: #e6fcf5;
      color: #0ca678;
      border: 1px solid #c3fae8;
    }
    .badge-interviewer {
      background: #e7f5ff;
      color: #1971c2;
      border: 1px solid #d0ebff;
    }
    .badge-default {
      background: #f1f3f5;
      color: #495057;
    }
    .turn-text {
      font-size: 12px;
      color: #212529;
      line-height: 1.4;
      flex: 1;
    }
    .footer-note {
      margin-top: 30px;
      border-top: 1px solid #e9ecef;
      padding-top: 10px;
      font-size: 10px;
      color: #adb5bd;
      text-align: center;
    }
    @media print {
      body { padding: 0; }
      .meta-card, .turn-row, .checklist-item { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-badge">OpenCluely • Executive Report</div>
      <div class="brand-title">${escapeHtml(title)}</div>
      <div class="header-subtitle">Transcrição e síntese processadas localmente com privacidade total</div>
    </div>
    <div style="text-align: right; font-size: 11px; color: #666;">
      <div>Arquivo: <strong>${escapeHtml(path.basename(target))}</strong></div>
      <div>Modo: <strong>${escapeHtml(skill)}</strong></div>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-card">
      <div class="meta-card-label">Duração</div>
      <div class="meta-card-value">${escapeHtml(duration)}</div>
    </div>
    <div class="meta-card">
      <div class="meta-card-label">Participantes</div>
      <div class="meta-card-value">${escapeHtml(speakers.join(', '))}</div>
    </div>
    <div class="meta-card">
      <div class="meta-card-label">Falas Registradas</div>
      <div class="meta-card-value">${meta.utteranceCount || lines.length}</div>
    </div>
    <div class="meta-card">
      <div class="meta-card-label">Palavras Faladas</div>
      <div class="meta-card-value">${meta.wordCount || 'Calculando...'}</div>
    </div>
  </div>

  <div class="section-title">🎯 Resumo Executivo da Reunião</div>
  <div class="summary-box">
    ${formattedSummaryHtml}
  </div>

  <div class="section-title">✅ Checklist de Ações & Próximos Passos (Action Items)</div>
  <div class="checklist-container">
    ${actionChecklistHtml}
  </div>

  <div class="section-title">💬 Transcrição das Falas (Diarização por Canal)</div>
  <div class="dialogue-container">
    ${dialogueHtml || '<div style="color: #888; font-style: italic;">Nenhuma fala registrada na transcrição.</div>'}
  </div>

  <div class="footer-note">
    Documento gerado automaticamente pelo OpenCluely • Zero Telemetria Externa • Armazenamento estritamente local
  </div>
</body>
</html>`;
  }
}

const transcriptLoggerInstance = new TranscriptLoggerManager();
transcriptLoggerInstance.TranscriptLoggerManager = TranscriptLoggerManager;
module.exports = transcriptLoggerInstance;

