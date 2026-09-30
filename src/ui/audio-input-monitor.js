class AudioInputMonitor {
    constructor(onLevel, onError) {
        this.onLevel = onLevel;
        this.onError = onError;
        this.generation = 0;
        this.deviceId = null;
        this.stream = null;
        this.audioContext = null;
        this.animationFrame = null;
    }

    async start(deviceId) {
        if (this.deviceId === deviceId && this.stream?.active) return;
        this.stop();
        this.deviceId = deviceId;
        const generation = this.generation;
        const constraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        };
        if (deviceId !== 'default') constraints.deviceId = { exact: deviceId };

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
            if (generation !== this.generation) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext = audioContext;
            if (audioContext.state === 'suspended') {
                audioContext.resume().catch(() => {});
            }
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);

            this.stream = stream;
            const samples = new Uint8Array(analyser.fftSize);
            let lastUpdate = 0;
            const update = (timestamp) => {
                if (generation !== this.generation) return;
                if (timestamp - lastUpdate >= 80) {
                    analyser.getByteTimeDomainData(samples);
                    let power = 0;
                    for (const sample of samples) {
                        const amplitude = (sample - 128) / 128;
                        power += amplitude * amplitude;
                    }
                    this.onLevel(Math.sqrt(power / samples.length));
                    lastUpdate = timestamp;
                }
                this.animationFrame = requestAnimationFrame(update);
            };
            this.animationFrame = requestAnimationFrame(update);
            stream.getAudioTracks()[0]?.addEventListener('ended', () => {
                if (generation !== this.generation) return;
                this.stop();
                this.onError(new Error('Dispositivo desconectado'));
            }, { once: true });
        } catch (error) {
            stream?.getTracks().forEach(track => track.stop());
            if (generation === this.generation) {
                this.stop();
                this.onError(error);
            }
        }
    }

    stop() {
        this.generation += 1;
        if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = null;
        this.audioContext?.close().catch(() => {});
        this.audioContext = null;
        this.deviceId = null;
        this.onLevel(0);
    }
}

window.AudioInputMonitor = AudioInputMonitor;
