const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function build(context = {}) {
  if (process.platform !== 'darwin') return;
  const projectDir = context.appDir || path.resolve(__dirname, '..');
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : process.arch;
  const bundle = path.join(projectDir, 'bin', 'system-audio-helper.app');
  const output = path.join(bundle, 'Contents', 'MacOS', 'system-audio-helper');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const target = arch === 'x64' ? 'x86_64-apple-macosx14.2' : 'arm64-apple-macosx14.2';
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-target', target,
    path.join(projectDir, 'scripts', 'system_audio_helper.swift'), '-o', output,
    '-framework', 'CoreAudio', '-framework', 'AudioToolbox'], { stdio: 'inherit' });
  fs.copyFileSync(path.join(projectDir, 'scripts', 'SystemAudioHelper-Info.plist'), path.join(bundle, 'Contents', 'Info.plist'));
  execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
}

module.exports = build;
if (require.main === module) build();
