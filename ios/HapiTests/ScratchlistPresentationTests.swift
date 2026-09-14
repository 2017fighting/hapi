import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

private struct ScratchlistOfflineHTTP: HTTPPerforming {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { throw URLError(.notConnectedToInternet) }
}

@MainActor
final class ScratchlistPresentationTests: XCTestCase {
    private func interactor() -> ChatInteractor {
        let url = URL(string: "https://scratchlist.invalid")!
        let http = ScratchlistOfflineHTTP()
        let auth = AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: http)
        let api = APIClient(baseURL: url, authManager: auth, performer: http)
        let interactor = ChatInteractor(sessionId: "preview", api: api, sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
        let stamp = Int(Date().timeIntervalSince1970 * 1000) - 120_000
        interactor.scratchlist = ScratchlistTestStore(entries: [
            ScratchlistEntry(entryId: "first", text: "检查登录后偶发的白屏，先补回归测试，再修复根因。", createdAt: stamp, updatedAt: stamp),
            ScratchlistEntry(entryId: "second", text: "主流程完成后，再补充深色模式和大字号的界面截图。", createdAt: stamp - 180_000, updatedAt: stamp - 180_000,
                attachments: [ScratchlistAttachment(id: "reference", filename: "dark-mode-reference.png", mimeType: "image/png", size: 100, path: "hub-reference")]),
            ScratchlistEntry(entryId: "third", text: "Review the release notes", createdAt: stamp - 600_000, updatedAt: stamp - 600_000),
        ])
        interactor.setComposerDestination(.scratchlist)
        return interactor
    }

    private struct Harness: View {
        let interactor: ChatInteractor
        let size: DynamicTypeSize
        let dark: Bool
        var body: some View {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("先梳理登录流程，修复问题后补上测试。")
                            .padding(14).background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
                        Text("正在检查会话恢复和登录状态切换。你可以先把后续想法暂存在草稿夹，不打断当前任务。")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(16)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ChatComposerView(interactor: interactor)
                }
                .navigationTitle("登录流程优化")
                .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTypography()
            .environment(\.dynamicTypeSize, size)
            .environment(\.locale, Locale(identifier: "zh-Hans"))
            .preferredColorScheme(dark ? .dark : .light)
        }
    }

    func testComposerRendersAtCompactRegularAndAccessibleSizes() async throws {
        for (name, width, size, dark) in [
            ("light", CGFloat(402), DynamicTypeSize.large, false),
            ("dark", CGFloat(402), DynamicTypeSize.large, true),
            ("compact", CGFloat(320), DynamicTypeSize.large, false),
            ("large-text", CGFloat(390), DynamicTypeSize.accessibility3, false),
        ] {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 874)
            let interactor = interactor()
            let host = UIHostingController(rootView: Harness(interactor: interactor, size: size, dark: dark))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            XCTAssertEqual(host.view.bounds.width, width, accuracy: 1)
            XCTAssertEqual(interactor.composerDestination, .scratchlist)
            XCTAssertEqual(interactor.scratchlistCount, 3)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 2
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "scratchlist-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("scratchlist-\(name).png")
            try XCTUnwrap(image.pngData()).write(to: url)
            print("SCRATCHLIST_CAPTURE=\(url.path)")
        }
    }

    func testKeyboardPreviewIsBoundedAndAccessibilityUsesSummaryOnly() async throws {
        let interactor = interactor()
        let store = try XCTUnwrap(interactor.scratchlist)
        for size in [DynamicTypeSize.large, .accessibility3] {
            let view = ScratchlistDrawerView(store: store, sessionId: "preview", interactor: interactor,
                keyboardFocused: true, onOpen: { _, _ in })
                .hapiTypography().environment(\.dynamicTypeSize, size)
            let host = UIHostingController(rootView: view)
            let fitting = host.sizeThatFits(in: CGSize(width: 320, height: 2000))
            XCTAssertLessThan(fitting.height, 310, "Keyboard preview must not become an unbounded inventory")
            XCTAssertLessThanOrEqual(fitting.width, 320)
        }
    }
}

extension ScratchlistPresentationTests {
    private struct ScrollRow: Identifiable, Equatable { let id: String }
    private struct ScrollHarness: View {
        let interactor: ChatInteractor
        let rows = (0..<100).map { ScrollRow(id: "message-\($0)") }
        var body: some View {
            AnchoredTranscriptList(items: rows, historyVersion: 0, jumpToken: 0,
                historyControlID: "history", onViewport: { _ in }, onLayout: { _, _ in }) { row in
                    AnyView(Text(verbatim: row.id).frame(maxWidth: .infinity).frame(height: 90))
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { ChatComposerView(interactor: interactor) }
                .hapiTypography()
        }
    }

    func testTogglingDrawerPreservesTranscriptIdentityAndReadingAnchor() async throws {
        let interactor = interactor()
        interactor.setComposerDestination(.chat)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: ScrollHarness(interactor: interactor))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(250))
        func find(_ view: UIView) -> UICollectionView? {
            if let collection = view as? UICollectionView { return collection }
            return view.subviews.lazy.compactMap(find).first
        }
        let list = try XCTUnwrap(find(host.view))
        list.delegate?.scrollViewWillBeginDragging?(list)
        list.scrollToItem(at: IndexPath(item: 25, section: 0), at: .top, animated: false)
        list.contentOffset.y += 13
        list.delegate?.scrollViewDidEndDragging?(list, willDecelerate: false)
        try await Task.sleep(for: .milliseconds(180))
        func anchor() -> (String, CGFloat)? {
            list.visibleCells.filter { $0.frame.maxY > list.contentOffset.y }
                .sorted { $0.frame.minY < $1.frame.minY }.first.map {
                    ($0.accessibilityIdentifier ?? "", $0.frame.minY - list.contentOffset.y)
                }
        }
        let before = try XCTUnwrap(anchor())
        for mode in [ComposerDestination.scratchlist, .chat] {
            interactor.setComposerDestination(mode)
            try await Task.sleep(for: .milliseconds(250))
            XCTAssertTrue(find(host.view) === list)
            let after = try XCTUnwrap(anchor())
            XCTAssertEqual(after.0, before.0)
            XCTAssertEqual(after.1, before.1, accuracy: 1)
        }
    }

    func testInventoryAndSingleStackEditorRender() async throws {
        let interactor = interactor()
        let store = try XCTUnwrap(interactor.scratchlist)
        let http = ScratchlistOfflineHTTP()
        let url = URL(string: "https://scratchlist.invalid")!
        let api = APIClient(baseURL: url,
            authManager: AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: http), performer: http)
        let loader = ScratchlistAttachmentLoader(api: api, sessionId: "preview")
        for editing in [false, true] {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
            let view = ScratchlistView(store: store, sessionId: "preview", attachments: loader, interactor: interactor,
                initialEntry: editing ? store.state("preview").entries.first : nil, initiallyEditing: editing)
                .hapiTypography().environment(\.locale, Locale(identifier: "zh-Hans"))
            window.rootViewController = UIHostingController(rootView: view)
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(350))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let name = editing ? "scratchlist-editor" : "scratchlist-inventory"
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).png")
            try XCTUnwrap(image.pngData()).write(to: file)
            print("SCRATCHLIST_CAPTURE=\(file.path)")
            XCTAssertEqual(store.state("preview").entries.count, 3)
        }
    }
}
