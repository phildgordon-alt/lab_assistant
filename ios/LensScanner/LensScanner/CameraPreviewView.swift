import SwiftUI
import AVFoundation

/// UIViewRepresentable wrapper for AVCaptureVideoPreviewLayer.
/// Displays the live camera feed in SwiftUI.
struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    var onTapLocation: ((CGPoint) -> Void)?

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        view.addGestureRecognizer(tap)

        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        // Preview layer auto-updates from session
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onTap: onTapLocation)
    }

    class Coordinator: NSObject {
        let onTap: ((CGPoint) -> Void)?
        init(onTap: ((CGPoint) -> Void)?) { self.onTap = onTap }

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let view = gesture.view else { return }
            let loc = gesture.location(in: view)
            // Convert to 0-1 range for AVFoundation focus point
            let point = CGPoint(x: loc.x / view.bounds.width, y: loc.y / view.bounds.height)
            onTap?(point)
        }
    }
}

/// UIView subclass that uses AVCaptureVideoPreviewLayer as its backing layer.
class PreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer.frame = bounds
    }
}
