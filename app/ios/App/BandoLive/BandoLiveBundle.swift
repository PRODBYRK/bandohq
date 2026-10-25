import SwiftUI
import WidgetKit

/// BANDOHQ:s widgettillägg: bara Live Activity för den pågående sessionen.
@main
struct BandoLiveBundle: WidgetBundle {
    var body: some Widget {
        SessionLiveActivity()
    }
}
