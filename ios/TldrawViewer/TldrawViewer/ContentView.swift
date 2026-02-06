import SwiftUI
import WebKit

struct ContentView: View {
    var body: some View {
        TldrawWebView()
            .ignoresSafeArea()
    }
}

struct TldrawWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.scrollView.isScrollEnabled = false  // tldraw handles its own scrolling
        webView.allowsBackForwardNavigationGestures = false

        // Store reference for JS evaluation
        context.coordinator.webView = webView

        // Set up Apple Pencil interaction
        let pencilInteraction = UIPencilInteraction()
        pencilInteraction.delegate = context.coordinator
        webView.addInteraction(pencilInteraction)

        // Load the dev server — change this to your Mac's local IP
        // The app will also check for a stored URL preference
        let urlString = UserDefaults.standard.string(forKey: "serverURL")
            ?? "http://10.0.0.18:5173/?doc=bregman"
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    class Coordinator: NSObject, UIPencilInteractionDelegate {
        weak var webView: WKWebView?

        // Tool cycle: draw → highlight → eraser → draw
        private let tools = ["draw", "highlight", "eraser"]

        func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
            guard let webView = webView else { return }

            let js = """
            (function() {
                const editor = window.__tldraw_editor__;
                if (!editor) return 'no-editor';
                const cycle = \(tools);
                const current = editor.getCurrentToolId();
                const idx = cycle.indexOf(current);
                const next = cycle[(idx + 1) % cycle.length];
                editor.setCurrentTool(next);
                return next;
            })()
            """

            webView.evaluateJavaScript(js) { result, error in
                if let tool = result as? String {
                    print("[Pencil] Switched to: \(tool)")
                }
                if let error = error {
                    print("[Pencil] JS error: \(error)")
                }
            }
        }
    }
}
