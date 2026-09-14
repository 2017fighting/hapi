import HapiClient
import HapiUI
import SwiftUI

/// A plan menu, not an approval footer. The proposal remains readable after
/// its live id is withdrawn; only the current root proposal can be executed.
struct CodexPlanActionsView: View {
    let planId: String
    let interactions: ChatInteractor
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let state = interactions.codexPlanActions(planId: planId)
        if state.isVisible {
            VStack(alignment: .leading, spacing: 8) {
                if let error = state.error {
                    Text(verbatim: LocalizedNoticeMapper.map(error))
                        .font(typography.captionFont)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("plan-error-\(planId)")
                }
                if state.available || state.pending {
                    // Prefer one compact row, but never squeeze or truncate
                    // the labels to fit a narrow column or larger text size.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            buttons(state: state, horizontal: true)
                        }
                        VStack(spacing: 8) {
                            buttons(state: state, horizontal: false)
                        }
                    }
                    .font(typography.toolTitleFont)
                    .disabled(!state.canAct)
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private func buttons(state: CodexPlanActionState, horizontal: Bool) -> some View {
        Button { interactions.implementCodexPlan(planId: planId) } label: {
            HStack(spacing: 8) {
                if state.pending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(theme.background)
                        .accessibilityHidden(true)
                }
                Text("Implement plan")
            }
            .fixedSize(horizontal: horizontal, vertical: true)
        }
        .buttonStyle(PlanActionButtonStyle(isPrimary: true))
        .accessibilityIdentifier("plan-implement-\(planId)")

        Button { interactions.continueCodexPlan(planId: planId) } label: {
            Text("Continue planning")
                .fixedSize(horizontal: horizontal, vertical: true)
        }
        .buttonStyle(PlanActionButtonStyle(isPrimary: false))
        .accessibilityIdentifier("plan-continue-\(planId)")
    }
}

/// Keep inline actions independent of the OS's bordered-button padding and
/// capsule shape. The entire visible control remains a minimum 44 pt target.
private struct PlanActionButtonStyle: ButtonStyle {
    let isPrimary: Bool
    @Environment(\.hapiTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        configuration.label
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(isPrimary ? theme.background : theme.textPrimary)
            .background(isPrimary ? theme.link : Color.clear, in: shape)
            .overlay(shape.strokeBorder(isPrimary ? Color.clear : theme.divider, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
    }
}
