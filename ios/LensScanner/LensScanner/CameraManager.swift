import AVFoundation
import UIKit

/// Manages the rear camera session, focus, exposure, and torch for lens scanning.
class CameraManager: NSObject, ObservableObject {
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var device: AVCaptureDevice?

    @Published var isRunning = false
    @Published var torchOn = false
    @Published var focusLocked = false

    private var photoContinuation: CheckedContinuation<UIImage?, Never>?

    func start() {
        guard !isRunning else { return }
        session.beginConfiguration()
        session.sessionPreset = .photo

        // Rear wide camera
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            print("[Camera] No rear camera available")
            return
        }
        device = cam

        do {
            let input = try AVCaptureDeviceInput(device: cam)
            if session.canAddInput(input) { session.addInput(input) }
            if session.canAddOutput(output) { session.addOutput(output) }
        } catch {
            print("[Camera] Setup error: \(error)")
            return
        }

        session.commitConfiguration()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
            DispatchQueue.main.async { self?.isRunning = true }
        }
    }

    func stop() {
        session.stopRunning()
        isRunning = false
    }

    // MARK: - Capture a still frame

    func capturePhoto() async -> UIImage? {
        return await withCheckedContinuation { continuation in
            self.photoContinuation = continuation
            let settings = AVCapturePhotoSettings()
            // High-res capture for OCR
            settings.isHighResolutionPhotoEnabled = output.isHighResolutionCaptureEnabled
            output.capturePhoto(with: settings, delegate: self)
        }
    }

    // MARK: - Torch (LED flashlight — useful for side-lighting etch marks)

    func toggleTorch() {
        guard let dev = device, dev.hasTorch else { return }
        do {
            try dev.lockForConfiguration()
            if dev.torchMode == .on {
                dev.torchMode = .off
                torchOn = false
            } else {
                try dev.setTorchModeOn(level: 1.0)
                torchOn = true
            }
            dev.unlockForConfiguration()
        } catch {
            print("[Camera] Torch error: \(error)")
        }
    }

    // MARK: - Focus lock (tap-to-focus, then lock for repeated scans)

    func lockFocus(at point: CGPoint) {
        guard let dev = device else { return }
        do {
            try dev.lockForConfiguration()
            if dev.isFocusPointOfInterestSupported {
                dev.focusPointOfInterest = point
                dev.focusMode = .autoFocus
            }
            if dev.isExposurePointOfInterestSupported {
                dev.exposurePointOfInterest = point
                dev.exposureMode = .autoExpose
            }
            dev.unlockForConfiguration()

            // After auto-focus settles, lock it
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let dev = self?.device else { return }
                do {
                    try dev.lockForConfiguration()
                    if dev.isFocusModeSupported(.locked) { dev.focusMode = .locked }
                    if dev.isExposureModeSupported(.locked) { dev.exposureMode = .locked }
                    dev.unlockForConfiguration()
                    DispatchQueue.main.async { self?.focusLocked = true }
                } catch {}
            }
        } catch {
            print("[Camera] Focus error: \(error)")
        }
    }

    func unlockFocus() {
        guard let dev = device else { return }
        do {
            try dev.lockForConfiguration()
            dev.focusMode = .continuousAutoFocus
            dev.exposureMode = .continuousAutoExposure
            dev.unlockForConfiguration()
            focusLocked = false
        } catch {}
    }
}

// MARK: - Photo capture delegate

extension CameraManager: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard let data = photo.fileDataRepresentation(),
              let image = UIImage(data: data) else {
            photoContinuation?.resume(returning: nil)
            photoContinuation = nil
            return
        }
        photoContinuation?.resume(returning: image)
        photoContinuation = nil
    }
}
