import Foundation

enum DeepLinks {
    static func isGroupURL(_ url: URL, groupID: UUID) -> Bool {
        guard url.scheme == "https", url.host?.lowercased() == "www.xelay.ink", url.port == nil, url.user == nil, url.password == nil,
              url.path.lowercased() == "/groups/" + groupID.uuidString.lowercased(), url.fragment == nil else { return false }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { return false }
        return items.allSatisfy { item in
            switch item.name {
            case "tab": return item.value == "schedule"
            case "date": return item.value.flatMap(KyivClock.parseDay) != nil
            case "assignment": return item.value.flatMap(UUID.init(uuidString:)) != nil
            case "kind": return item.value == "homework"
            default: return false
            }
        }
    }
    static func webURL(for choice: GroupChoice, mode: WidgetMode) -> URL {
        URL(string: "https://www.xelay.ink/groups/\(choice.group.id.uuidString.lowercased())?tab=schedule")!
    }
    static func appURL(for choice: GroupChoice, mode: WidgetMode, destination: URL? = nil) -> URL {
        var value = URLComponents(); value.scheme = "xelaywidgets"; value.host = "group"
        value.queryItems = [.init(name: "account", value: choice.accountID.uuidString.lowercased()), .init(name: "id", value: choice.group.id.uuidString.lowercased()), .init(name: "mode", value: mode.rawValue)]
        if let destination, isGroupURL(destination, groupID: choice.group.id) { value.queryItems?.append(.init(name: "destination", value: destination.absoluteString)) }
        return value.url!
    }
    static let appHome = URL(string: "xelaywidgets://home")!
}
