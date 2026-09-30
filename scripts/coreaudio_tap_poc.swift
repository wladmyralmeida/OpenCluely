import AudioToolbox
import CoreAudio
import Foundation

@available(macOS 14.2, *)
final class SystemAudioTapProof {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var callbackCount = 0
    private var peak: Float = 0

    func start() throws {
        let outputUID = try defaultOutputUID()
        let tapUUID = UUID()
        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDescription.uuid = tapUUID
        tapDescription.name = "OpenCluely System Audio POC"
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = .unmuted

        try requireSuccess(AudioHardwareCreateProcessTap(tapDescription, &tapID), "creating system-audio tap")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OpenCluely System Audio POC",
            kAudioAggregateDeviceUIDKey: "com.opencluely.system-audio-poc." + UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUUID.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        try requireSuccess(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "creating aggregate device")

        try requireSuccess(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) { [weak self] _, inputData, _, outputData, _ in
                guard let self else { return }
                let input = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
                let output = UnsafeMutableAudioBufferListPointer(outputData)
                self.callbackCount += 1

                for (index, sourceBuffer) in input.enumerated() {
                    guard let source = sourceBuffer.mData else { continue }
                    let samples = source.assumingMemoryBound(to: Float.self)
                    let count = Int(sourceBuffer.mDataByteSize) / MemoryLayout<Float>.size
                    for sample in UnsafeBufferPointer(start: samples, count: count) {
                        self.peak = max(self.peak, abs(sample))
                    }
                    guard index < output.count, let destination = output[index].mData else { continue }
                    destination.copyMemory(from: source, byteCount: Int(min(sourceBuffer.mDataByteSize, output[index].mDataByteSize)))
                }
            },
            "creating audio callback"
        )
        guard let ioProcID else { throw CaptureError.operation("creating audio callback") }
        try requireSuccess(AudioDeviceStart(aggregateID, ioProcID), "starting audio capture")
        write("Core Audio tap started. Play audio in Teams or another app.\n")
    }

    func stop() {
        if let ioProcID {
            _ = AudioDeviceStop(aggregateID, ioProcID)
            _ = AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        if aggregateID != kAudioObjectUnknown { _ = AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { _ = AudioHardwareDestroyProcessTap(tapID) }
        write("coreaudio-tap callbacks=\(callbackCount) peak=\(String(format: "%.4f", peak))\n")
    }

    private func defaultOutputUID() throws -> String {
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try requireSuccess(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID), "reading default output")

        var uidPointer: UnsafeRawPointer?
        address.mSelector = kAudioDevicePropertyDeviceUID
        size = UInt32(MemoryLayout<UnsafeRawPointer?>.size)
        try requireSuccess(AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uidPointer), "reading output UID")
        guard let uidPointer else { throw CaptureError.operation("reading output UID") }
        let uid = Unmanaged<CFString>.fromOpaque(uidPointer).takeUnretainedValue()
        return uid as String
    }

    private func requireSuccess(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw CaptureError.status(operation, status) }
    }
}

enum CaptureError: LocalizedError {
    case operation(String)
    case status(String, OSStatus)

    var errorDescription: String? {
        switch self {
        case let .operation(operation): return "Could not complete \(operation)."
        case let .status(operation, status): return "Could not complete \(operation) (OSStatus \(status))."
        }
    }
}

private func write(_ message: String) {
    FileHandle.standardOutput.write(Data(message.utf8))
    let logURL = URL(fileURLWithPath: "/tmp/opencluely-coreaudio-tap-poc.log")
    guard let data = message.data(using: .utf8) else { return }
    if FileManager.default.fileExists(atPath: logURL.path), let handle = try? FileHandle(forWritingTo: logURL) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    } else {
        try? data.write(to: logURL)
    }
}

@main
struct CoreAudioTapPOC {
    static func main() {
        guard #available(macOS 14.2, *) else {
            fputs("Core Audio taps require macOS 14.2 or later.\n", stderr)
            exit(2)
        }
        let seconds = max(1, Int(CommandLine.arguments.dropFirst().first ?? "15") ?? 15)
        let proof = SystemAudioTapProof()
        do {
            try proof.start()
            Thread.sleep(forTimeInterval: TimeInterval(seconds))
            proof.stop()
        } catch {
            proof.stop()
            fputs("Could not start Core Audio tap: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
