import Foundation
import Observation

@MainActor @Observable
final class StatusStore {
    var icon: IconState { .red }
}
