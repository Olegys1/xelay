import AppIntents
import WidgetKit

extension WidgetTheme: AppEnum {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Тема віджета")
    static var caseDisplayRepresentations: [WidgetTheme: DisplayRepresentation] = [
        .system: "Як на iPhone", .light: "Світла", .dark: "Темна", .halloween: "Гелловін"
    ]
}

struct StudyGroupEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Навчальна група")
    static var defaultQuery = StudyGroupQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    init(choice: GroupChoice) { id = choice.id; name = choice.label }
    var choice: GroupChoice? {
        guard let (accountID, groupID) = GroupChoice.parseID(id) else { return nil }
        // Stored labels are presentation only. The RPC validates the UUID and
        // returns current group metadata; no label ever grants membership.
        return GroupChoice(accountID: accountID, group: AcademicGroup(id: groupID, name: name, course: nil, degree: nil))
    }
}

struct StudyGroupQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [StudyGroupEntity] {
        let wanted = Set(identifiers.prefix(50))
        return try await availableGroups().filter { wanted.contains($0.id) }.map(StudyGroupEntity.init)
    }
    func suggestedEntities() async throws -> [StudyGroupEntity] { try await availableGroups().map(StudyGroupEntity.init) }
    func defaultResult() async -> StudyGroupEntity? { nil }
    private func availableGroups() async throws -> [GroupChoice] {
        let client = try XelayClient()
        do { return try await client.groups() }
        catch {
            guard canUseOfflineCache(error) else { throw error }
            return try await client.cachedGroups()
        }
    }
}

struct StudyWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Налаштування Xelay"
    static var description = IntentDescription("Оберіть свою навчальну групу та окрему тему для цього віджета.")
    @Parameter(title: "Навчальна група") var group: StudyGroupEntity?
    @Parameter(title: "Тема", default: .system) var theme: WidgetTheme
}

struct RefreshWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Оновити Xelay"
    static var openAppWhenRun = false
    @Parameter(title: "Віджет") var mode: String
    init() { mode = "schedule" }
    init(mode: String) { self.mode = mode }
    func perform() async throws -> some IntentResult {
        // WidgetKit reloads the timeline and its provider makes the authenticated
        // request. iOS owns the budget; this is a refresh request, not a timer.
        WidgetCenter.shared.reloadTimelines(ofKind: mode == "homework" ? "XelayDeadlines" : "XelaySchedule")
        return .result()
    }
}

func canUseOfflineCache(_ error: Error) -> Bool {
    guard let error = error as? XelayError else { return false }
    switch error {
    case .network, .rateLimited, .storageBusy: return true
    case .api(let status, _): return status >= 500
    default: return false
    }
}
