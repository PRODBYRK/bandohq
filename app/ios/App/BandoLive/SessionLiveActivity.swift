import ActivityKit
import SwiftUI
import WidgetKit

/// Bandos neonrör (--tube i webbappen) och skyltens typsnitt: systemets smala, tunga skärning
/// ligger närmast Barlow Condensed utan att typsnittet behöver följa med tillägget.
private let tube = Color(red: 1.0, green: 0.243, blue: 0.749)          // #ff3ebf
private func sign(_ size: CGFloat) -> Font { .system(size: size, weight: .heavy).width(.condensed) }
private func label(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold) }

private extension Color {
    /// "#7c3aed" → färgen; något annat → neonröret
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard s.count == 6, let v = UInt32(s, radix: 16) else { self = tube; return }
        self = Color(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}

private func clock(_ d: Date) -> String { d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }

struct SessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.78))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let s = context.state, a = context.attributes
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(context.isStale ? "SLUT" : "PÅGÅR")
                            .font(label(10)).tracking(1.6).foregroundStyle(tube)
                        Text(a.studio.uppercased())
                            .font(sign(19)).foregroundStyle(Color(hex: a.colorHex)).lineLimit(1)
                    }
                    .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: s.range, countsDown: true)
                        .font(sign(30)).monospacedDigit().foregroundStyle(.white)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 112, alignment: .trailing)
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        ProgressView(timerInterval: s.range, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
                            .tint(tube)
                        HStack {
                            Text(a.title).lineLimit(1)
                            Spacer(minLength: 8)
                            Text("\(clock(s.start))–\(clock(s.end))").monospacedDigit()
                        }
                        .font(label(12)).foregroundStyle(.white.opacity(0.6))
                    }
                    .padding(.horizontal, 6)
                }
            } compactLeading: {
                Image(systemName: "waveform")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(tube)
                    .padding(.leading, 2)
            } compactTrailing: {
                Text(timerInterval: s.range, countsDown: true)
                    .font(label(13)).monospacedDigit().foregroundStyle(tube)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 50, alignment: .trailing)
            } minimal: {
                ProgressView(timerInterval: s.range, countsDown: true) { EmptyView() } currentValueLabel: {
                    Image(systemName: "waveform").font(.system(size: 8, weight: .bold))
                }
                .progressViewStyle(.circular)
                .tint(tube)
            }
            .keylineTint(tube)
            .widgetURL(URL(string: "https://www.bandohq.se/"))
        }
    }
}

/// Låsskärmen (och notiscentret): studion och tiden till vänster, nedräkningen stort till höger,
/// förloppet under — samma ordning som passkortet i appen.
private struct LockScreenView: View {
    let context: ActivityViewContext<SessionAttributes>

    var body: some View {
        let s = context.state, a = context.attributes
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: a.colorHex)).frame(width: 7, height: 7)
                        Text((context.isStale ? "SLUT · " : "PÅGÅR · ") + a.studio.uppercased())
                            .font(label(11)).tracking(1.6).foregroundStyle(tube).lineLimit(1)
                    }
                    Text(a.title).font(sign(24)).foregroundStyle(.white).lineLimit(1)
                    Text("\(a.who) · \(clock(s.start))–\(clock(s.end))")
                        .font(label(13)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 0) {
                    if context.isStale {
                        Text("KLAR").font(sign(34)).foregroundStyle(.white)
                    } else {
                        Text(timerInterval: s.range, countsDown: true)
                            .font(sign(36)).monospacedDigit().foregroundStyle(.white)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 124, alignment: .trailing)
                    }
                    Text("KVAR").font(label(10)).tracking(1.6).foregroundStyle(.white.opacity(0.5))
                        .opacity(context.isStale ? 0 : 1)
                }
            }
            ProgressView(timerInterval: s.range, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
                .tint(tube)
        }
        .padding(16)
    }
}
