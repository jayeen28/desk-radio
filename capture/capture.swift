// Captures audio and writes raw PCM (s16le, 48 kHz, stereo) for ffmpeg to encode. The source is either
// "system" (everything the Mac plays, no driver needed), "app:<bundle id>" (only what that app plays, e.g.
// app:com.bitgapp.eqmac for eqMac's enhanced output), or an input device's unique ID (e.g. BlackHole).
//   capture --list                     list input devices as JSON
//   capture <system|device>            PCM to stdout
//   capture <system|device> --connect <port>  PCM to a TCP socket on 127.0.0.1 (used when launched as an app,
//                                      so macOS asks for microphone permission for this app itself)
// Build: ./build.sh

import AVFoundation
import CoreAudio
import Foundation

// `capture --list` prints every Core Audio device that has input channels as JSON [{ "id", "name" }].
func listInputDevices() -> [[String: String]] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }

    func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    func inputChannels(_ id: AudioObjectID) -> Int {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    return ids.compactMap { id in
        guard inputChannels(id) > 0, let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return ["id": uid, "name": string(id, kAudioObjectPropertyName) ?? uid]
    }
}

if CommandLine.arguments.dropFirst().first == "--list" {
    let data = try! JSONSerialization.data(withJSONObject: listInputDevices())
    FileHandle.standardOutput.write(data)
    exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
let deviceID = args.first ?? "system"

signal(SIGPIPE, SIG_IGN)

func connectedSocket(port: UInt16) -> FileHandle {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard fd >= 0, ok == 0 else {
        FileHandle.standardError.write("capture: cannot connect to 127.0.0.1:\(port)\n".data(using: .utf8)!)
        exit(1)
    }
    return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}

let sink: FileHandle = {
    if let i = args.firstIndex(of: "--connect"), i + 1 < args.count, let port = UInt16(args[i + 1]) {
        return connectedSocket(port: port)
    }
    return FileHandle.standardOutput
}()

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("capture: \(message)\n".data(using: .utf8)!)
    exit(1)
}

func emit(_ data: Data) {
    do {
        try sink.write(contentsOf: data)
    } catch {
        exit(0) // reader (ffmpeg / server) went away
    }
}

// MARK: - Input device (eqMac, BlackHole, microphone…)

final class Writer: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let pointer else { return }
        emit(Data(bytes: pointer, count: length))
    }
}

let session = AVCaptureSession()
let writer = Writer()

func startDevice(_ id: String) {
    guard let device = AVCaptureDevice(uniqueID: id) else { fail("device \(id) not found") }
    do {
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw NSError(domain: "capture", code: 1) }
        session.addInput(input)
    } catch {
        fail("cannot open \(id): \(error)")
    }

    let output = AVCaptureAudioDataOutput()
    output.audioSettings = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 48000,
        AVNumberOfChannelsKey: 2,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]
    output.setSampleBufferDelegate(writer, queue: DispatchQueue(label: "capture"))
    session.addOutput(output)
    session.startRunning()
    FileHandle.standardError.write("capture: streaming \(device.localizedName)\n".data(using: .utf8)!)
}

// MARK: - "system": everything the Mac plays, via a Core Audio process tap (macOS 14.2+, no driver).
// The tap sits before the output device's volume, so listeners get full level whatever the Mac volume is.

func defaultOutputUID() -> String {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr else { fail("no default output device") }
    address.mSelector = kAudioDevicePropertyDeviceUID
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid) == noErr, let uid else { fail("cannot read output device UID") }
    return uid.takeRetainedValue() as String
}

// Core Audio process objects whose bundle ID matches (an app can have several, e.g. helpers).
func processObjects(bundleID: String) -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.filter { id in
        var addr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let value else { return false }
        return (value.takeRetainedValue() as String) == bundleID
    }
}

/// Taps everything the Mac plays, or only the given app (bundle ID) when `app` is set.
@available(macOS 14.2, *)
func startSystemTap(app: String? = nil) {
    func check(_ status: OSStatus, _ what: String) {
        if status != noErr { fail("\(what) failed (OSStatus \(status))") }
    }

    let tap: CATapDescription
    if let app {
        let processes = processObjects(bundleID: app)
        if processes.isEmpty { fail("\(app) is not running or has not played audio yet") }
        tap = CATapDescription(stereoMixdownOfProcesses: processes)

        // If the app quits or restarts, its process objects change; quit so the server relaunches us.
        var list = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &list, DispatchQueue.main) { _, _ in
            if Set(processObjects(bundleID: app)) != Set(processes) {
                FileHandle.standardError.write("capture: \(app) restarted, restarting\n".data(using: .utf8)!)
                exit(0)
            }
        }
    } else {
        tap = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    }
    tap.uuid = UUID()
    tap.muteBehavior = .unmuted
    tap.isPrivate = true
    var tapID = AudioObjectID(kAudioObjectUnknown)
    check(AudioHardwareCreateProcessTap(tap, &tapID), "creating the system audio tap")

    var format = AudioStreamBasicDescription()
    var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    check(AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format), "reading the tap format")

    let outputUID = defaultOutputUID()
    let description: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Music Share Tap",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceMainSubDeviceKey: outputUID,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tap.uuid.uuidString]],
    ]
    var aggregateID = AudioObjectID(kAudioObjectUnknown)
    check(AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateID), "creating the capture device")

    // The tap reports its own rate, but buffers arrive at the capture device's actual rate (the output
    // device's, e.g. 96 kHz); trusting the tap would make the stream play at the wrong speed.
    var rateAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var deviceRate = Float64(0)
    size = UInt32(MemoryLayout<Float64>.size)
    if AudioObjectGetPropertyData(aggregateID, &rateAddress, 0, nil, &size, &deviceRate) == noErr, deviceRate > 0 {
        format.mSampleRate = deviceRate
    }
    AudioObjectAddPropertyListenerBlock(aggregateID, &rateAddress, DispatchQueue.main) { _, _ in
        FileHandle.standardError.write("capture: sample rate changed, restarting\n".data(using: .utf8)!)
        exit(0)
    }

    guard let inFormat = AVAudioFormat(streamDescription: &format),
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 2, interleaved: true),
          let converter = AVAudioConverter(from: inFormat, to: outFormat) else { fail("unsupported tap format") }

    var procID: AudioDeviceIOProcID?
    check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, DispatchQueue(label: "tap")) { _, inputData, _, _, _ in
        guard let input = AVAudioPCMBuffer(pcmFormat: inFormat, bufferListNoCopy: inputData, deallocator: nil),
              input.frameLength > 0 else { return }
        let capacity = AVAudioFrameCount(Double(input.frameLength) * outFormat.sampleRate / inFormat.sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var supplied = false
        converter.convert(to: output, error: nil) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        guard output.frameLength > 0, let samples = output.int16ChannelData else { return }
        emit(Data(bytes: samples[0], count: Int(output.frameLength) * 2 * MemoryLayout<Int16>.size))
    }, "creating the capture callback")
    check(AudioDeviceStart(aggregateID, procID), "starting the capture")

    // The tap is clocked by the current output device; if that changes, quit so the server relaunches us.
    var defaultOutput = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultOutput, DispatchQueue.main) { _, _ in
        FileHandle.standardError.write("capture: output device changed, restarting\n".data(using: .utf8)!)
        exit(0)
    }

    FileHandle.standardError.write("capture: streaming \(app ?? "system audio") (\(Int(inFormat.sampleRate)) Hz)\n".data(using: .utf8)!)
}

if deviceID == "system" || deviceID.hasPrefix("app:") {
    guard #available(macOS 14.2, *) else { fail("system audio capture needs macOS 14.2 or later") }
    startSystemTap(app: deviceID.hasPrefix("app:") ? String(deviceID.dropFirst(4)) : nil)
} else {
    startDevice(deviceID)
}

dispatchMain()
