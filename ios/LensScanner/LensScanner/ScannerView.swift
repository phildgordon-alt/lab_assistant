import SwiftUI

// MARK: - Data model

struct ScanEntry: Identifiable {
    let id = UUID()
    let jobNumber: String
    let confidence: Double
    let timestamp: Date
    var posted: Bool = false     // true after successful POST to Lab_Assistant
    var postError: String? = nil
    var matchedStage: String? = nil  // e.g. "COATING", "ASSEMBLY"
    var matchedTray: String? = nil
    var serverMessage: String? = nil
}

// MARK: - Main scanner view

struct ScannerView: View {
    @StateObject private var camera = CameraManager()
    @StateObject private var api = LabAssistantAPI()

    @State private var phase: ScanPhase = .idle
    @State private var scanLog: [ScanEntry] = []
    @State private var currentResult: OCREngine.ScanResult?
    @State private var showSettings = false
    @State private var serverHealthy = false

    enum ScanPhase {
        case idle       // Camera not started
        case ready      // Camera live, waiting for scan
        case scanning   // Capture + OCR in progress
        case found      // Result displayed
        case error(String)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                header

                // Camera preview
                ZStack {
                    if camera.isRunning {
                        CameraPreviewView(session: camera.session) { point in
                            camera.lockFocus(at: point)
                        }
                        .ignoresSafeArea(edges: .horizontal)

                        // Bracket overlay
                        bracketOverlay

                        // Scanning indicator
                        if case .scanning = phase {
                            scanningOverlay
                        }

                        // Result overlay
                        if case .found = phase, let result = currentResult {
                            resultOverlay(result)
                        }
                    } else {
                        startScreen
                    }
                }
                .frame(maxHeight: .infinity)

                // Controls
                controls
            }
        }
        .sheet(isPresented: $showSettings) {
            settingsSheet
        }
        .task {
            serverHealthy = await api.checkHealth()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("LENS SCANNER")
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundColor(Color(hex: "00e5ff"))
                Text("JOB NUMBER DETECTION · PAIR EYEWEAR")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundColor(Color(hex: "4a5568"))
            }
            Spacer()
            // Status dot
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .shadow(color: statusColor.opacity(0.8), radius: 4)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(Color(hex: "0f1318"))
    }

    private var statusColor: Color {
        switch phase {
        case .idle: return Color(hex: "4a5568")
        case .ready: return Color(hex: "00ff88")
        case .scanning: return Color(hex: "00e5ff")
        case .found: return Color(hex: "00ff88")
        case .error: return Color(hex: "ff4455")
        }
    }

    // MARK: - Start screen

    private var startScreen: some View {
        VStack(spacing: 16) {
            Text("🔍").font(.system(size: 56))
            Text("LENS JOB SCANNER")
                .font(.system(size: 18, weight: .semibold, design: .monospaced))
                .foregroundColor(Color(hex: "00e5ff"))
            Text("Point the camera at an etched lens on a dark background. Tap Scan to read the job number.")
                .font(.system(size: 14))
                .foregroundColor(Color(hex: "4a5568"))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            Text("Use a dark cloth or black foam under the lens. Angle a light from the side for best results.")
                .font(.system(size: 12))
                .foregroundColor(Color(hex: "2a3540"))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(hex: "080a0d"))
    }

    // MARK: - Bracket overlay

    private var bracketOverlay: some View {
        GeometryReader { geo in
            let insetX = geo.size.width * 0.12
            let insetY = geo.size.height * 0.28
            let bracketSize: CGFloat = 48

            // Top-left
            BracketShape(corner: .topLeft)
                .stroke(Color(hex: "00e5ff"), lineWidth: 2)
                .frame(width: bracketSize, height: bracketSize)
                .position(x: insetX + bracketSize / 2, y: insetY + bracketSize / 2)
                .opacity(0.65)

            // Top-right
            BracketShape(corner: .topRight)
                .stroke(Color(hex: "00e5ff"), lineWidth: 2)
                .frame(width: bracketSize, height: bracketSize)
                .position(x: geo.size.width - insetX - bracketSize / 2, y: insetY + bracketSize / 2)
                .opacity(0.65)

            // Bottom-left
            BracketShape(corner: .bottomLeft)
                .stroke(Color(hex: "00e5ff"), lineWidth: 2)
                .frame(width: bracketSize, height: bracketSize)
                .position(x: insetX + bracketSize / 2, y: geo.size.height - insetY - bracketSize / 2)
                .opacity(0.65)

            // Bottom-right
            BracketShape(corner: .bottomRight)
                .stroke(Color(hex: "00e5ff"), lineWidth: 2)
                .frame(width: bracketSize, height: bracketSize)
                .position(x: geo.size.width - insetX - bracketSize / 2, y: geo.size.height - insetY - bracketSize / 2)
                .opacity(0.65)
        }
        .allowsHitTesting(false)
    }

    // MARK: - Scanning overlay

    private var scanningOverlay: some View {
        VStack {
            Spacer()
            Text("SCANNING...")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundColor(Color(hex: "00e5ff"))
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color.black.opacity(0.7))
                .cornerRadius(6)
            Spacer()
        }
    }

    // MARK: - Result overlay

    private func resultOverlay(_ result: OCREngine.ScanResult) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Spacer()
            VStack(alignment: .leading, spacing: 6) {
                Text("DETECTED JOB NUMBER")
                    .font(.system(size: 10, weight: .regular, design: .monospaced))
                    .foregroundColor(Color(hex: "4a5568"))
                    .tracking(2)

                Text(result.jobNumber)
                    .font(.system(size: 38, weight: .bold, design: .monospaced))
                    .foregroundColor(Color(hex: "00ff88"))
                    .tracking(3)

                Text("\(Int(result.confidence * 100))% CONFIDENCE")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundColor(Color(hex: "4a5568"))

                if !result.allCandidates.isEmpty && result.allCandidates.count > 1 {
                    Text("Also found: \(result.allCandidates.dropFirst().prefix(3).joined(separator: ", "))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(Color(hex: "2a3540"))
                }

                HStack(spacing: 10) {
                    Button("COPY") {
                        UIPasteboard.general.string = result.jobNumber
                    }
                    .buttonStyle(ScannerButtonStyle(color: Color(hex: "00ff88")))

                    Button("POST TO LAB") {
                        Task { await postResult(result) }
                    }
                    .buttonStyle(ScannerButtonStyle(color: Color(hex: "00e5ff")))
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(colors: [.clear, .black.opacity(0.9)], startPoint: .top, endPoint: .bottom)
            )
        }
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 10) {
            // Main action button
            Button(action: handleMainAction) {
                Text(mainButtonLabel)
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .tracking(2)
                    .foregroundColor(mainButtonDisabled ? Color(hex: "4a5568") : .black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .background(mainButtonDisabled ? Color(hex: "1c2330") : Color(hex: "00e5ff"))
                    .cornerRadius(4)
            }
            .disabled(mainButtonDisabled)

            // Tool buttons row
            if camera.isRunning {
                HStack(spacing: 8) {
                    Button(action: camera.toggleTorch) {
                        Label(camera.torchOn ? "LIGHT ON" : "LIGHT OFF", systemImage: camera.torchOn ? "flashlight.on.fill" : "flashlight.off.fill")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(camera.torchOn ? Color(hex: "ffd60a") : Color(hex: "4a5568"))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color(hex: "080a0d"))
                            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(hex: "1c2330"), lineWidth: 1))
                            .cornerRadius(3)
                    }

                    Button(action: {
                        if camera.focusLocked { camera.unlockFocus() } else { camera.lockFocus(at: CGPoint(x: 0.5, y: 0.5)) }
                    }) {
                        Label(camera.focusLocked ? "FOCUS LOCKED" : "LOCK FOCUS", systemImage: camera.focusLocked ? "lock.fill" : "lock.open")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(camera.focusLocked ? Color(hex: "00ff88") : Color(hex: "4a5568"))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color(hex: "080a0d"))
                            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(hex: "1c2330"), lineWidth: 1))
                            .cornerRadius(3)
                    }

                    Button(action: { showSettings = true }) {
                        Label("SETUP", systemImage: "gearshape")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(Color(hex: "4a5568"))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Color(hex: "080a0d"))
                            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(hex: "1c2330"), lineWidth: 1))
                            .cornerRadius(3)
                    }
                }
            }

            // Scan log
            if !scanLog.isEmpty {
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(scanLog) { entry in
                            HStack(spacing: 10) {
                                Text(entry.jobNumber)
                                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                                    .foregroundColor(Color(hex: "00ff88"))

                                Spacer()

                                if entry.posted {
                                    HStack(spacing: 4) {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(Color(hex: "00ff88"))
                                            .font(.system(size: 12))
                                        if let stage = entry.matchedStage {
                                            Text(stage)
                                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                                .foregroundColor(Color(hex: "00e5ff"))
                                        }
                                    }
                                } else if let err = entry.postError {
                                    Text(err)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(Color(hex: "ff4455"))
                                }

                                Text("\(entry.timestamp.formatted(date: .omitted, time: .standard)) · \(Int(entry.confidence * 100))%")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(Color(hex: "4a5568"))

                                Button("COPY") {
                                    UIPasteboard.general.string = entry.jobNumber
                                }
                                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundColor(Color(hex: "00e5ff"))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .overlay(RoundedRectangle(cornerRadius: 2).stroke(Color(hex: "00e5ff").opacity(0.2), lineWidth: 1))
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color(hex: "080a0d"))
                            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(hex: "1c2330"), lineWidth: 1))
                            .cornerRadius(3)
                        }
                    }
                }
                .frame(maxHeight: 120)
            }

            // Status bar
            Text(statusMessage)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Color(hex: "4a5568"))
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(Color(hex: "0f1318"))
    }

    // MARK: - Settings sheet

    private var settingsSheet: some View {
        NavigationView {
            Form {
                Section("Lab_Assistant Server") {
                    TextField("Server URL", text: $api.serverURL)
                        .font(.system(.body, design: .monospaced))
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                    HStack {
                        Text("Status")
                        Spacer()
                        Circle()
                            .fill(serverHealthy ? Color.green : Color.red)
                            .frame(width: 8, height: 8)
                        Text(serverHealthy ? "Connected" : "Unreachable")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundColor(.secondary)
                    }

                    Button("Test Connection") {
                        Task {
                            serverHealthy = await api.checkHealth()
                        }
                    }
                }

                Section("Camera") {
                    HStack {
                        Text("Torch")
                        Spacer()
                        Text(camera.torchOn ? "On" : "Off")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Focus")
                        Spacer()
                        Text(camera.focusLocked ? "Locked" : "Auto")
                            .foregroundColor(.secondary)
                    }
                }

                Section("Scan Log") {
                    Text("\(scanLog.count) scans this session")
                    if !scanLog.isEmpty {
                        Button("Clear Log", role: .destructive) {
                            scanLog.removeAll()
                        }
                    }
                }

                Section("About") {
                    HStack {
                        Text("App")
                        Spacer()
                        Text("LensScanner v1.0")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("OCR Engine")
                        Spacer()
                        Text("Apple Vision")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Recognition")
                        Spacer()
                        Text("Accurate (on-device)")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { showSettings = false }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Actions

    private var mainButtonLabel: String {
        switch phase {
        case .idle: return "START CAMERA"
        case .ready, .found: return "SCAN"
        case .scanning: return "SCANNING..."
        case .error: return "RETRY"
        }
    }

    private var mainButtonDisabled: Bool {
        if case .scanning = phase { return true }
        return false
    }

    private var statusMessage: String {
        switch phase {
        case .idle: return "TAP START TO BEGIN"
        case .ready: return "READY — TAP SCAN OR TAP SCREEN TO FOCUS"
        case .scanning: return "SCANNING..."
        case .found:
            if let r = currentResult {
                return "DETECTED — \(Int(r.confidence * 100))% CONFIDENCE"
            }
            return "DETECTED"
        case .error(let msg): return msg
        }
    }

    private func handleMainAction() {
        switch phase {
        case .idle, .error:
            camera.start()
            phase = .ready
        case .ready, .found:
            Task { await performScan() }
        case .scanning:
            break
        }
    }

    private func performScan() async {
        phase = .scanning
        currentResult = nil

        guard let photo = await camera.capturePhoto() else {
            phase = .error("CAPTURE FAILED — CHECK CAMERA")
            return
        }

        // Pre-process for etch mark visibility
        let processed = OCREngine.preprocessForEtch(photo)

        do {
            if let result = try await OCREngine.recognizeText(in: processed) {
                currentResult = result
                phase = .found

                let entry = ScanEntry(
                    jobNumber: result.jobNumber,
                    confidence: result.confidence,
                    timestamp: Date()
                )
                scanLog.insert(entry, at: 0)
                if scanLog.count > 20 { scanLog = Array(scanLog.prefix(20)) }
            } else {
                phase = .ready
                // Briefly show error then return to ready
                phase = .error("NO TEXT FOUND — ADJUST POSITION & LIGHTING")
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if case .error = phase { phase = .ready }
            }
        } catch {
            phase = .error("OCR ERROR: \(error.localizedDescription)")
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if case .error = phase { phase = .ready }
        }
    }

    private func postResult(_ result: OCREngine.ScanResult) async {
        guard let idx = scanLog.firstIndex(where: { $0.jobNumber == result.jobNumber && !$0.posted }) else { return }

        do {
            let response = try await api.postScan(jobNumber: result.jobNumber, confidence: result.confidence)
            if response.success {
                scanLog[idx].posted = true
                scanLog[idx].matchedStage = response.stage
                scanLog[idx].matchedTray = response.trayId
                scanLog[idx].serverMessage = response.message
            } else {
                scanLog[idx].postError = response.message ?? "Failed"
            }
        } catch {
            scanLog[idx].postError = error.localizedDescription
        }
    }
}

// MARK: - Bracket shape

struct BracketShape: Shape {
    enum Corner { case topLeft, topRight, bottomLeft, bottomRight }
    let corner: Corner

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let len: CGFloat = min(rect.width, rect.height)
        switch corner {
        case .topLeft:
            p.move(to: CGPoint(x: 0, y: len))
            p.addLine(to: CGPoint(x: 0, y: 0))
            p.addLine(to: CGPoint(x: len, y: 0))
        case .topRight:
            p.move(to: CGPoint(x: rect.width - len, y: 0))
            p.addLine(to: CGPoint(x: rect.width, y: 0))
            p.addLine(to: CGPoint(x: rect.width, y: len))
        case .bottomLeft:
            p.move(to: CGPoint(x: 0, y: rect.height - len))
            p.addLine(to: CGPoint(x: 0, y: rect.height))
            p.addLine(to: CGPoint(x: len, y: rect.height))
        case .bottomRight:
            p.move(to: CGPoint(x: rect.width, y: rect.height - len))
            p.addLine(to: CGPoint(x: rect.width, y: rect.height))
            p.addLine(to: CGPoint(x: rect.width - len, y: rect.height))
        }
        return p
    }
}

// MARK: - Button style

struct ScannerButtonStyle: ButtonStyle {
    let color: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundColor(color)
            .padding(.horizontal, 16)
            .padding(.vertical, 5)
            .background(color.opacity(0.1))
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(color.opacity(0.3), lineWidth: 1))
            .cornerRadius(3)
            .opacity(configuration.isPressed ? 0.6 : 1.0)
    }
}

// MARK: - Color hex extension

extension Color {
    init(hex: String) {
        let scanner = Scanner(string: hex)
        var rgb: UInt64 = 0
        scanner.scanHexInt64(&rgb)
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}
