const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SYSTEM_AUDIO_SOURCE = 'system-audio-macos';

class SystemAudioService extends EventEmitter {
  constructor() { super(); this.process = null; this.pending = Buffer.alloc(0); this.samplePhase = 0; }

  isSupported() { return process.platform === 'darwin'; }

  start() {
    if (this.process) return;
    if (!this.isSupported()) throw new Error('Áudio do sistema está disponível apenas no macOS.');
    const binary = this._binaryPath();
    if (!fs.existsSync(binary)) throw new Error('O helper de áudio do sistema não foi encontrado. Reinstale o OpenCluely.');
    this.process = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process.stdout.on('data', (data) => this._handleFloat32(data));
    this.process.stderr.on('data', (data) => this.emit('status', data.toString().trim()));
    this.process.once('error', (error) => this._fail(error));
    this.process.once('exit', (code, signal) => {
      const unexpected = this.process;
      this.process = null;
      if (unexpected && code && code !== 0) this._fail(new Error(`Captura de áudio do sistema terminou (${code}${signal ? `, ${signal}` : ''}).`));
    });
  }

  stop() {
    const child = this.process;
    this.process = null;
    this.pending = Buffer.alloc(0);
    this.samplePhase = 0;
    if (child && !child.killed) child.kill('SIGTERM');
  }

  _binaryPath() {
    if (process.resourcesPath) {
      const packaged = path.join(process.resourcesPath, 'system-audio-helper.app', 'Contents', 'MacOS', 'system-audio-helper');
      if (fs.existsSync(packaged)) return packaged;
    }
    return path.join(__dirname, '..', '..', 'bin', 'system-audio-helper.app', 'Contents', 'MacOS', 'system-audio-helper');
  }

  _handleFloat32(data) {
    const source = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const length = source.length - (source.length % 4);
    this.pending = source.subarray(length);
    const output = Buffer.allocUnsafe(Math.ceil(length / 12) * 2);
    let written = 0;
    // The helper supplies 48 kHz mono float PCM. Downsample to 16 kHz PCM16,
    // the format consumed by the existing Whisper VAD pipeline.
    for (let offset = 0; offset < length; offset += 4) {
      if (this.samplePhase++ % 3) continue;
      const value = Math.max(-1, Math.min(1, source.readFloatLE(offset)));
      output.writeInt16LE(value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), written);
      written += 2;
    }
    if (written) this.emit('audio', output.subarray(0, written));
  }

  _fail(error) { this.emit('error', error); }
}

module.exports = { SystemAudioService, SYSTEM_AUDIO_SOURCE };
