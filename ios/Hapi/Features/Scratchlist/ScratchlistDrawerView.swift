import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// A bounded preview, not another scroll view competing with the transcript.
struct ScratchlistDrawerView: View {
    @State private var model: ScratchlistScreenModel
    let interactor: ChatInteractor
    let keyboardFocused: Bool
    let onOpen: (ScratchlistEntry?, Bool) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.hapiTypography) private var typography

    init(store: any SessionScratchlistStoring, sessionId: String, interactor: ChatInteractor,
         keyboardFocused: Bool, onOpen: @escaping (ScratchlistEntry?, Bool) -> Void) {
        _model = State(initialValue: ScratchlistScreenModel(sessionId: sessionId, store: store))
        self.interactor = interactor
        self.keyboardFocused = keyboardFocused
        self.onOpen = onOpen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    title
                    Spacer(minLength: 8)
                    navigation
                }
                VStack(alignment: .leading, spacing: 0) { title; navigation }
            }
            Text("Held — not sent")
                .font(typography.captionFont).foregroundStyle(.secondary)
                .padding(.bottom, 6)
            if let error = model.notice {
                ScratchlistErrorBanner(message: error, actionTitle: "Dismiss") { model.clearNotice() }
            }
            if model.isLoading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12)
            } else if model.state.loadFailed || model.state.refreshFailed {
                ScratchlistErrorBanner(message: String(localized: "Couldn't refresh — showing saved drafts")) { model.retry() }
            }
            if model.state.loaded, model.state.entries.isEmpty {
                Button("Write the first draft") { interactor.focusComposer() }
                    .frame(minHeight: 44)
            } else if !dynamicTypeSize.isAccessibilitySize {
                ForEach(model.state.entries.prefix(keyboardFocused ? 1 : 2)) { entry in
                    ScratchlistEntryRow(entry: entry, interactor: interactor,
                        onOpen: { onOpen(entry, false) }, onEdit: { onOpen(entry, true) },
                        onDelete: { model.deleteEntry(entry.entryId) }, compact: true)
                        .disabled(model.deletingEntryId != nil)
                    Divider()
                }
            }
            if model.state.atCap {
                Text("Scratchlist is full (200 entries)").font(.footnote).foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .accessibilityIdentifier("scratchlist.drawer")
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private var title: some View {
        HStack(spacing: 6) {
            Image(systemName: "tray").foregroundStyle(.orange)
            Text("Scratchlist").font(.subheadline.weight(.semibold))
            Text(verbatim: "\(model.state.entries.count)").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var navigation: some View {
        HStack(spacing: 14) {
            Button { onOpen(nil, false) } label: {
                Text("View all").frame(minHeight: 44).contentShape(Rectangle())
            }
            Button { interactor.setComposerDestination(.chat) } label: {
                Text("Back to chat").frame(minHeight: 44).contentShape(Rectangle())
            }
                .disabled(interactor.scratchlistBusy || interactor.isSending)
        }
        .font(.subheadline)
        .frame(minHeight: 44)
    }
}
