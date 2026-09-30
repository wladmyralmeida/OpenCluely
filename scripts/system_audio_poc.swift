import AudioToolbox
import CoreMedia
import CoreGraphics
import Foundation
import ScreenCaptureKit

@available(macOS 13.0, *)
final class SystemAudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private let queue = DispatchQueue(label: "com.opencluely.system-audio-poc")
    private var stream: SCStream?
    private var lastReportedAt = ContinuousClock.now
    private var reportedFormat = false

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let ownBundleID = Bundle.main.bundleIdentifier
        let excludedApps = content.applications.filter { app in
            app.bundleIdentifier == ownBundleID
        }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApps,
            exceptingWindows: []
        )

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        // This command-line proof does not render audio itself. Keeping this
        // false makes the first compatibility test independent of process
        // identity; the integrated app will set it to true to avoid feedback.
        configuration.excludesCurrentProcessAudio = false
        // Keep ScreenCaptureKit's standard output format for this proof. The
        // production path can resample to Whisper's 16 kHz mono format later.
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.queueDepth = 3
        configuration.width = display.width
        configuration.height = display.height

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        // Some macOS releases only activate the system-audio path when the
        // stream also has a screen output. The proof ignores screen buffers.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream

        write("System audio capture started at 48 kHz stereo. Play audio in Teams or another app.\n")
    }

    func stop() async {
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
        write("System audio capture stopped.\n")
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        write("Capture stopped: \(error.localizedDescription)\n")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio, sampleBuffer.isValid,
              let format = sampleBuffer.formatDescription,
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)
        else { return }

        let level = rmsLevel(sampleBuffer: sampleBuffer, format: description.pointee)
        if !reportedFormat {
            reportedFormat = true
            let audioFormat = description.pointee
            write(
                "system-audio format id=\(audioFormat.mFormatID) flags=\(audioFormat.mFormatFlags) " +
                "bits=\(audioFormat.mBitsPerChannel) bytesPerFrame=\(audioFormat.mBytesPerFrame) " +
                "channels=\(audioFormat.mChannelsPerFrame) sampleRate=\(audioFormat.mSampleRate)\n"
            )
        }
        let now = ContinuousClock.now
        guard now - lastReportedAt >= .milliseconds(500) else { return }
        lastReportedAt = now
        write(String(format: "system-audio level=%.4f\n", level))
    }

    private func rmsLevel(sampleBuffer: CMSampleBuffer, format: AudioStreamBasicDescription) -> Double {
        let bufferListSize = MemoryLayout<AudioBufferList>.size + 7 * MemoryLayout<AudioBuffer>.size
        let rawBufferList = UnsafeMutableRawPointer.allocate(
            byteCount: bufferListSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { rawBufferList.deallocate() }

        let audioBufferList = rawBufferList.bindMemory(to: AudioBufferList.self, capacity: 1)
        var retainedBlockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList,
            bufferListSize: bufferListSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &retainedBlockBuffer
        )
        guard status == noErr else { return 0 }

        let isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSignedInteger = (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        var totalPower = 0.0
        var sampleCount = 0

        for buffer in UnsafeMutableAudioBufferListPointer(audioBufferList) {
            guard let data = buffer.mData else { continue }
            if isFloat && format.mBitsPerChannel == 32 {
                let samples = data.bindMemory(to: Float.self, capacity: Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
                for sample in UnsafeBufferPointer(start: samples, count: Int(buffer.mDataByteSize) / MemoryLayout<Float>.size) {
                    totalPower += Double(sample * sample)
                    sampleCount += 1
                }
            } else if isSignedInteger && format.mBitsPerChannel == 16 {
                let samples = data.bindMemory(to: Int16.self, capacity: Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size)
                for sample in UnsafeBufferPointer(start: samples, count: Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size) {
                    let normalized = Double(sample) / Double(Int16.max)
                    totalPower += normalized * normalized
                    sampleCount += 1
                }
            }
        }

        guard sampleCount > 0 else { return 0 }
        return (totalPower / Double(sampleCount)).squareRoot()
    }

    private func write(_ message: String) {
        FileHandle.standardOutput.write(Data(message.utf8))
        let logURL = URL(fileURLWithPath: "/tmp/opencluely-system-audio-poc.log")
        guard let data = message.data(using: .utf8) else { return }
        if FileManager.default.fileExists(atPath: logURL.path) {
            if let handle = try? FileHandle(forWritingTo: logURL) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            }
        } else {
            try? data.write(to: logURL)
        }
    }
}

enum CaptureError: LocalizedError {
    case noDisplay

    var errorDescription: String? {
        "No display is available for system-audio capture."
    }
}

@main
struct SystemAudioProofOfConcept {
    static func main() async {
        guard #available(macOS 13.0, *) else {
            fputs("ScreenCaptureKit system audio requires macOS 13 or later.\n", stderr)
            exit(2)
        }

        let arguments = Array(CommandLine.arguments.dropFirst())
        if !CGPreflightScreenCaptureAccess() {
            if arguments.contains("--request-permission") {
                _ = CGRequestScreenCaptureAccess()
            }
            fputs(
                "Screen Recording permission is required. Enable it for the running terminal/app, then run again.\n",
                stderr
            )
            exit(3)
        }

        let seconds = max(1, Int(arguments.first(where: { $0 != "--request-permission" }) ?? "20") ?? 20)
        let capture = SystemAudioCapture()
        do {
            try await capture.start()
            try await Task.sleep(for: .seconds(seconds))
            await capture.stop()
        } catch {
            fputs("Could not start system audio capture: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
