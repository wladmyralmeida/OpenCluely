const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('WHISPER-WORKER');

/**
 * A single persistent Python Whisper subprocess.
 * Internal to WhisperWorkerService — callers should use the pool API.
 */
class WhisperWorkerProcess {
  constructor({ pythonPath, scriptPath }) {
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.process = null;
    this.pending = new Map();
    this.sequence = 0;
    this.readyInfo = null;
    this.closing = false;
    this.busy = false; // true while a transcription request is in-flight
  }

  ensureProcess() {
    if (this.process && !this.process.killed) {
      return;
    }

    this.readyInfo = null;
    this.closing = false;
    const child = spawn(this.pythonPath, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this._handleLine(line));

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        logger.debug('Worker stderr', { message: message.substring(0, 1000) });
      }
    });

    child.on('error', (error) => {
      logger.error('Whisper worker process error', { error: error.message });
      this._rejectAll(error);
    });

    child.on('close', (code) => {
      const error = new Error(`Whisper worker exited with code ${code}`);
      if (!this.closing && code !== 0) {
        logger.error(error.message);
      }
      this.process = null;
      this.readyInfo = null;
      this.busy = false;
      if (!this.closing) {
        this._rejectAll(error);
      }
      this.closing = false;
    });
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_err) {
      logger.warn('Ignoring non-JSON worker output', { line: line.substring(0, 500) });
      return;
    }

    if (message.event === 'ready') {
      this.readyInfo = message;
      logger.info('Persistent Whisper worker ready', message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.busy = false;

    if (message.ok) {
      pending.resolve(message);
    } else {
      const error = new Error(message.error || 'Whisper worker request failed');
      error.workerTraceback = message.traceback;
      pending.reject(error);
    }
  }

  request(payload, timeoutMs = 180000) {
    this.ensureProcess();
    const id = ++this.sequence;
    const request = { ...payload, id };
    this.busy = true;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.busy = false;
        reject(new Error(`Whisper worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          this.busy = false;
          reject(error);
        }
      });
    });
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.busy = false;
  }

  close() {
    if (this.process && !this.process.killed) {
      try {
        this.closing = true;
        this.process.kill();
      } catch (_) {
        // Ignore shutdown races.
      }
    }
    this.process = null;
    this.readyInfo = null;
    this._rejectAll(new Error('Whisper worker closed'));
  }
}

/**
 * A pool of persistent Whisper worker processes.
 *
 * Workers are spawned lazily: the first request spawns worker-1; the second
 * concurrent request spawns worker-2 (up to `maxWorkers`). If all workers are
 * busy a job queue drains onto the next worker that becomes free, eliminating
 * the hard serial bottleneck of having a single process.
 *
 * External API is identical to the old single-worker service so no other files
 * need to change beyond using this module.
 */
class WhisperWorkerService {
  constructor(maxWorkers = 2) {
    this.pythonPath = null;
    this.scriptPath = null;
    this.idleUnloadMs = 60000;
    this.idleTimer = null;
    this.maxWorkers = maxWorkers;
    this._workers = [];    // active WhisperWorkerProcess instances
    this._jobQueue = [];   // pending jobs waiting for a free worker
  }

  configure({ pythonPath, scriptPath, idleUnloadMs = 60000 }) {
    const changed = this.pythonPath !== pythonPath || this.scriptPath !== scriptPath;
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.idleUnloadMs = idleUnloadMs;
    if (changed) {
      this.close();
    }
  }

  isConfigured() {
    return Boolean(
      this.pythonPath &&
      this.scriptPath &&
      fs.existsSync(this.pythonPath) &&
      fs.existsSync(this.scriptPath)
    );
  }

  async transcribe(audioPath, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Persistent Whisper worker is not configured');
    }
    this._clearIdleTimer();
    const result = await this._dispatch({
      action: 'transcribe',
      audio_path: audioPath,
      model: options.model || 'small',
      language: options.language || 'auto',
      model_dir: options.modelDir || null,
      device: options.device || 'auto'
    });
    this._scheduleIdleUnload();
    return result;
  }

  async warmup(options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Persistent Whisper worker is not configured');
    }
    this._clearIdleTimer();
    return this._dispatch({
      action: 'warmup',
      model: options.model || 'small',
      model_dir: options.modelDir || null,
      device: options.device || 'auto'
    });
  }

  releaseWhenIdle() {
    if (this._workers.some((w) => w.process)) {
      this._scheduleIdleUnload();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal pool dispatch
  // ---------------------------------------------------------------------------

  _dispatch(payload) {
    return new Promise((resolve, reject) => {
      this._runOrQueue({ payload, resolve, reject });
    });
  }

  _runOrQueue(job) {
    // Find an idle (non-busy) existing worker.
    let worker = this._workers.find((w) => !w.busy);

    // No idle worker — can we spawn a new one?
    if (!worker && this._workers.length < this.maxWorkers) {
      worker = new WhisperWorkerProcess({
        pythonPath: this.pythonPath,
        scriptPath: this.scriptPath
      });
      this._workers.push(worker);
      logger.info(
        `Spawned Whisper worker #${this._workers.length} (pool ${this._workers.length}/${this.maxWorkers})`
      );
    }

    if (worker) {
      this._runJob(worker, job);
    } else {
      // All workers at capacity — queue the job.
      this._jobQueue.push(job);
      logger.debug(`Transcription queued (depth: ${this._jobQueue.length})`);
    }
  }

  _runJob(worker, job) {
    worker.request(job.payload).then(
      (result) => {
        job.resolve(result);
        this._drainQueue(worker);
      },
      (error) => {
        job.reject(error);
        this._drainQueue(worker);
      }
    );
  }

  _drainQueue(worker) {
    if (this._jobQueue.length > 0) {
      const next = this._jobQueue.shift();
      logger.debug(`Draining job queue — ${this._jobQueue.length} remaining`);
      this._runJob(worker, next);
    }
  }

  // ---------------------------------------------------------------------------
  // Idle model unload (keeps process alive, frees GPU/RAM)
  // ---------------------------------------------------------------------------

  _scheduleIdleUnload() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      const hasWork =
        this._jobQueue.length > 0 || this._workers.some((w) => w.busy);
      if (hasWork) {
        return;
      }
      for (const w of this._workers) {
        if (w.process) {
          w.request({ action: 'unload' }, 30000)
            .then(() => logger.info('Whisper model unloaded (idle timeout)'))
            .catch((e) =>
              logger.warn('Could not unload idle Whisper model', { error: e.message })
            );
        }
      }
    }, this.idleUnloadMs);
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  close() {
    this._clearIdleTimer();
    for (const w of this._workers) {
      w.close();
    }
    this._workers = [];
    for (const job of this._jobQueue) {
      job.reject(new Error('Whisper worker pool closed'));
    }
    this._jobQueue = [];
  }
}

module.exports = WhisperWorkerService;
