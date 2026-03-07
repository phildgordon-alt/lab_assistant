import Foundation

/// Handles communication with the Lab_Assistant server.
/// Posts detected job numbers and retrieves job details.
class LabAssistantAPI: ObservableObject {

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "la_server_url") }
    }

    init() {
        self.serverURL = UserDefaults.standard.string(forKey: "la_server_url") ?? "http://localhost:3002"
    }

    // MARK: - Post a scanned job number to Lab_Assistant

    struct ScanPayload: Codable {
        let jobNumber: String
        let confidence: Double
        let scannedAt: String   // ISO 8601
        let device: String      // "ipad"
    }

    struct ScanResponse: Codable {
        let success: Bool
        let message: String?
        let jobId: String?
        let trayId: String?
        let stage: String?
        let station: String?
        let `operator`: String?
    }

    func postScan(jobNumber: String, confidence: Double) async throws -> ScanResponse {
        let url = URL(string: "\(serverURL)/api/vision/scan")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10

        let payload = ScanPayload(
            jobNumber: jobNumber,
            confidence: confidence,
            scannedAt: ISO8601DateFormatter().string(from: Date()),
            device: "ipad"
        )
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.serverError
        }
        return try JSONDecoder().decode(ScanResponse.self, from: data)
    }

    // MARK: - Check server health

    func checkHealth() async -> Bool {
        guard let url = URL(string: "\(serverURL)/api/vision/health") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    enum APIError: LocalizedError {
        case serverError
        var errorDescription: String? { "Server returned an error" }
    }
}
