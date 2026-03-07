import Vision
import UIKit

/// Runs Apple Vision text recognition on captured lens images.
/// VNRecognizeTextRequest is significantly better than Tesseract for faint/etched text.
struct OCREngine {

    struct ScanResult {
        let jobNumber: String       // Best candidate job number
        let confidence: Double      // 0.0–1.0
        let allCandidates: [String] // All text lines found
        let rawText: String         // Full OCR output
    }

    /// Recognize text in an image. Runs on-device, no network needed.
    /// Uses .accurate recognition level for best results on faint etch marks.
    static func recognizeText(in image: UIImage) async throws -> ScanResult? {
        guard let cgImage = image.cgImage else { return nil }

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }

                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(returning: nil)
                    return
                }

                // Collect all recognized text lines with confidence
                var allLines: [(text: String, confidence: Float)] = []
                for obs in observations {
                    if let top = obs.topCandidates(1).first {
                        let cleaned = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
                        if cleaned.count >= 3 {
                            allLines.append((text: cleaned, confidence: top.confidence))
                        }
                    }
                }

                guard !allLines.isEmpty else {
                    continuation.resume(returning: nil)
                    return
                }

                // Score each line — job numbers typically have digits and are 5+ chars
                let scored = allLines.map { line -> (text: String, score: Double) in
                    var score = Double(line.confidence)
                    let digitCount = line.text.filter(\.isNumber).count
                    let hasDigits = digitCount > 0
                    let digitRatio = Double(digitCount) / Double(line.text.count)

                    // Boost lines that look like job numbers
                    if hasDigits { score += 0.3 }
                    if digitRatio > 0.3 { score += 0.2 }
                    if line.text.count >= 5 && line.text.count <= 20 { score += 0.1 }
                    // Penalize very short or very long strings
                    if line.text.count < 4 { score -= 0.3 }
                    if line.text.count > 25 { score -= 0.2 }

                    return (text: line.text, score: score)
                }.sorted { $0.score > $1.score }

                let best = scored[0]
                let rawText = allLines.map(\.text).joined(separator: " ")

                let result = ScanResult(
                    jobNumber: best.text.uppercased(),
                    confidence: min(1.0, max(0.0, best.score)),
                    allCandidates: scored.map(\.text),
                    rawText: rawText
                )
                continuation.resume(returning: result)
            }

            // Use accurate (not fast) for best results on etched text
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false  // Job numbers aren't words
            // Allow alphanumeric + common separators
            request.customWords = []  // No dictionary bias

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do {
                try handler.perform([request])
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    /// Pre-process image for better OCR on etched/engraved marks.
    /// Converts to grayscale and boosts contrast — same idea as the Tesseract.js version
    /// but Apple Vision is much better at this natively.
    static func preprocessForEtch(_ image: UIImage) -> UIImage {
        guard let ciImage = CIImage(image: image) else { return image }

        let filter = CIFilter(name: "CIColorControls")!
        filter.setValue(ciImage, forKey: kCIInputImageKey)
        filter.setValue(0.0, forKey: kCIInputSaturationKey)  // Grayscale
        filter.setValue(1.5, forKey: kCIInputContrastKey)     // Boost contrast
        filter.setValue(0.1, forKey: kCIInputBrightnessKey)   // Slight brighten

        guard let output = filter.outputImage else { return image }

        let context = CIContext()
        guard let cgImage = context.createCGImage(output, from: output.extent) else { return image }
        return UIImage(cgImage: cgImage)
    }
}
