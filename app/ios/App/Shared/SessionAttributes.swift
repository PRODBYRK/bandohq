import ActivityKit
import Foundation

/// En pågående session i Dynamic Island och på låsskärmen.
/// Servern startar den med push (notify-send, push-to-start), så namnen här — strukturens namn,
/// fälten och ContentState — är ett kontrakt med `sendLiveStart` där. Ändra båda samtidigt.
@available(iOS 16.1, *)
struct SessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Sekunder sedan 1970. Inte `Date`: den avkodas från 2001 och servern skickar Unix-tid.
        var startEpoch: Double
        var endEpoch: Double
    }

    var bookingId: String
    var title: String
    var studio: String
    var colorHex: String
    var who: String
}

@available(iOS 16.1, *)
extension SessionAttributes.ContentState {
    var start: Date { Date(timeIntervalSince1970: startEpoch) }
    /// minst en minut, så att intervallet aldrig blir baklänges
    var end: Date { Date(timeIntervalSince1970: max(endEpoch, startEpoch + 60)) }
    var range: ClosedRange<Date> { start...end }
}
