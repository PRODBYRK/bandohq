import ActivityKit
import Capacitor
import Foundation
import UIKit

/// BANDOHQ:s egna funktioner i iPhone-appen, för webbsidan (window.Capacitor, "BandoNative"):
/// - appearance: om Liquid Glass ska visas — iOS 26 och "Minska genomskinlighet" avstängt.
///   Skickar "appearance" när inställningen ändras medan appen är öppen.
/// - liveStart / liveEnd / liveState: den pågående sessionen i Dynamic Island och på låsskärmen.
/// - "liveToken": telefonens push-to-start-token (iOS 17.2+), så att servern kan starta
///   Live Activity när passet börjar även om appen är stängd.
@objc(BandoNativePlugin)
public class BandoNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BandoNativePlugin"
    public let jsName = "BandoNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "appearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveEnd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveState", returnType: CAPPluginReturnPromise)
    ]
    private var startToken: String?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(appearanceChanged),
                                               name: UIAccessibility.reduceTransparencyStatusDidChangeNotification, object: nil)
        if #available(iOS 17.2, *) {
            Task { [weak self] in
                for await data in Activity<SessionAttributes>.pushToStartTokenUpdates {
                    let hex = data.map { String(format: "%02x", $0) }.joined()
                    self?.startToken = hex
                    self?.notifyListeners("liveToken", data: ["token": hex])
                }
            }
        }
    }

    // MARK: Liquid Glass

    private func appearanceInfo() -> [String: Any] {
        let reduce = UIAccessibility.isReduceTransparencyEnabled
        var glass = false
        if #available(iOS 26.0, *) { glass = !reduce }
        return ["glass": glass, "reduceTransparency": reduce, "ios": UIDevice.current.systemVersion]
    }

    @objc private func appearanceChanged() {
        notifyListeners("appearance", data: appearanceInfo())
    }

    @objc func appearance(_ call: CAPPluginCall) {
        call.resolve(appearanceInfo())
    }

    // MARK: Live Activity

    @objc func liveState(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve(["supported": false]) }
        let ids = Activity<SessionAttributes>.activities.filter { $0.activityState == .active }.map { $0.attributes.bookingId }
        call.resolve(["supported": true, "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
                      "ids": ids, "startToken": startToken ?? ""])
    }

    /// Startar (eller låter vara) sessionens Live Activity. Andra pass avslutas — det finns
    /// bara en pågående session åt gången.
    @objc func liveStart(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve(["started": false, "reason": "ios"]) }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return call.resolve(["started": false, "reason": "off"]) }
        guard let id = call.getString("id"), let startMs = call.getDouble("start"), let endMs = call.getDouble("end"),
              endMs > startMs, endMs / 1000 > Date().timeIntervalSince1970 else {
            return call.reject("Passet saknar tid")
        }
        let state = SessionAttributes.ContentState(startEpoch: startMs / 1000, endEpoch: endMs / 1000)
        let all = Activity<SessionAttributes>.activities
        for a in all where a.attributes.bookingId != id {
            Task { await a.end(nil, dismissalPolicy: .immediate) }
        }
        if let same = all.first(where: { $0.attributes.bookingId == id && $0.activityState == .active }) {
            /* samma pass: uppdatera bara om tiden ändrats */
            if same.content.state != state {
                Task { await same.update(ActivityContent(state: state, staleDate: state.end)) }
            }
            return call.resolve(["started": true, "updated": true])
        }
        let attrs = SessionAttributes(bookingId: id, title: call.getString("title") ?? "Session",
                                      studio: call.getString("studio") ?? "", colorHex: call.getString("color") ?? "#ff3ebf",
                                      who: call.getString("who") ?? "")
        do {
            _ = try Activity.request(attributes: attrs, content: ActivityContent(state: state, staleDate: state.end), pushType: nil)
            call.resolve(["started": true])
        } catch {
            call.reject("Kunde inte starta: \(error.localizedDescription)")
        }
    }

    /// Avslutar Live Activity. `past: true` tar bara de vars pass redan är slut; `id` ett visst pass;
    /// annars alla.
    @objc func liveEnd(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve(["ended": 0]) }
        let id = call.getString("id"), past = call.getBool("past") ?? false, now = Date()
        let hit = Activity<SessionAttributes>.activities.filter { a in
            (id == nil || a.attributes.bookingId == id) && (!past || a.content.state.end <= now)
        }
        for a in hit { Task { await a.end(nil, dismissalPolicy: .immediate) } }
        call.resolve(["ended": hit.count])
    }
}
