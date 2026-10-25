import Capacitor
import UIKit

/// Capacitors webbvy med BANDOHQ:s egna tillägg registrerade (BandoNativePlugin).
class BandoBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BandoNativePlugin())
    }
}
