import AudioToolbox
import CoreAudio
import Foundation

@available(macOS 14.2, *)
final class SystemAudioHelper {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    func start() throws {
        let outputUID = try defaultOutputUID()
        let tapUUID = UUID()
        let tap = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tap.uuid = tapUUID
        tap.name = "OpenCluely System Audio"
        tap.isPrivate = true
        tap.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(tap, &tapID), "creating system audio tap")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OpenCluely System Audio",
            kAudioAggregateDeviceUIDKey: "com.opencluely.system-audio." + UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUUID.uuidString, kAudioSubTapDriftCompensationKey: true]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "creating aggregate device")
        try check(AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) { _, inputData, _, outputData, _ in
            let input = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
            let output = UnsafeMutableAudioBufferListPointer(outputData)
            // The system tap is float PCM. Its first buffer is sent unchanged to
            // stdout; the Electron parent converts it to Whisper's 16 kHz PCM.
            if let first = input.first, let data = first.mData, first.mDataByteSize > 0 {
                FileHandle.standardOutput.write(Data(bytes: data, count: Int(first.mDataByteSize)))
            }
            for (index, source) in input.enumerated() where index < output.count {
                guard let from = source.mData, let to = output[index].mData else { continue }
                to.copyMemory(from: from, byteCount: Int(min(source.mDataByteSize, output[index].mDataByteSize)))
            }
        }, "creating audio callback")
        guard let ioProcID else { throw HelperError.operation("creating audio callback") }
        try check(AudioDeviceStart(aggregateID, ioProcID), "starting audio capture")
        fputs("SYSTEM_AUDIO_FORMAT float32le 48000 1\n", stderr)
    }

    func stop() {
        if let ioProcID { _ = AudioDeviceStop(aggregateID, ioProcID); _ = AudioDeviceDestroyIOProcID(aggregateID, ioProcID) }
        if aggregateID != kAudioObjectUnknown { _ = AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { _ = AudioHardwareDestroyProcessTap(tapID) }
    }

    private func defaultOutputUID() throws -> String {
        var device = AudioObjectID(kAudioObjectUnknown)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device), "reading default output")
        var pointer: UnsafeRawPointer?
        address.mSelector = kAudioDevicePropertyDeviceUID
        size = UInt32(MemoryLayout<UnsafeRawPointer?>.size)
        try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &pointer), "reading output UID")
        guard let pointer else { throw HelperError.operation("reading output UID") }
        return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
    }

    private func check(_ status: OSStatus, _ operation: String) throws {
        if status != noErr { throw HelperError.status(operation, status) }
    }
}

enum HelperError: LocalizedError { case operation(String), status(String, OSStatus)
    var errorDescription: String? { switch self { case let .operation(s): return s; case let .status(s, code): return "\(s) (OSStatus \(code))" } }
}

@main struct Main {
    static func main() {
        guard #available(macOS 14.2, *) else { fputs("System audio requires macOS 14.2 or later.\n", stderr); exit(2) }
        let helper = SystemAudioHelper()
        do { try helper.start(); RunLoop.current.run() } catch { helper.stop(); fputs("System audio unavailable: \(error.localizedDescription)\n", stderr); exit(1) }
    }
}
