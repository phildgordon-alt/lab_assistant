import SwiftUI

@main
struct LensScannerApp: App {
    var body: some Scene {
        WindowGroup {
            ScannerView()
                .preferredColorScheme(.dark)
        }
    }
}
