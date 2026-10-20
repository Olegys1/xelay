import WidgetKit
import Foundation

struct StudyWidgetEntry: TimelineEntry {
    let date: Date
    let choice: GroupChoice?
    let mode: WidgetMode
    let theme: WidgetTheme
    let snapshot: WidgetSnapshot?
    let notice: String?
    let offline: Bool
    let demonstration: Bool
    static func example(mode: WidgetMode, theme: WidgetTheme = .system) -> StudyWidgetEntry {
        let sample = WidgetSnapshot.demo
        return StudyWidgetEntry(date: sample.generatedAt.addingTimeInterval(20 * 60),
            choice: GroupChoice(accountID: UUID(uuidString: "00000000-0000-4000-8000-000000000005")!, group: sample.group),
            mode: mode, theme: theme, snapshot: sample, notice: nil, offline: false, demonstration: true)
    }
}

struct StudyWidgetProvider: AppIntentTimelineProvider {
    let mode: WidgetMode
    func placeholder(in context: Context) -> StudyWidgetEntry { .example(mode: mode) }
    func snapshot(for configuration: StudyWidgetIntent, in context: Context) async -> StudyWidgetEntry {
        if context.isPreview { return .example(mode: mode, theme: configuration.theme) }
        return await load(configuration)
    }
    func timeline(for configuration: StudyWidgetIntent, in context: Context) async -> Timeline<StudyWidgetEntry> {
        let entry = await load(configuration)
        // No network is needed to switch a current class to a completed class.
        // Explicit future timeline entries handle exact starts/ends, Kyiv date
        // boundaries and the six-hour private-cache expiry if iOS delays reload.
        let end = min(entry.date.addingTimeInterval(6 * 3600), entry.snapshot?.generatedAt.addingTimeInterval(6 * 3600) ?? entry.date)
        let boundaries = Array((entry.snapshot?.nextBoundaries(after: entry.date) ?? []).filter { $0 <= end }.prefix(52))
        let entries = [entry] + boundaries.map { date in
            StudyWidgetEntry(date: date, choice: entry.choice, mode: mode, theme: entry.theme, snapshot: entry.snapshot,
                notice: entry.notice, offline: entry.offline, demonstration: false)
        }
        return Timeline(entries: entries, policy: .after(entry.date.addingTimeInterval(30 * 60)))
    }
    private func load(_ configuration: StudyWidgetIntent) async -> StudyWidgetEntry {
        let now = Date()
        func empty(_ notice: String) -> StudyWidgetEntry {
            StudyWidgetEntry(date: now, choice: configuration.group?.choice, mode: mode, theme: configuration.theme,
                snapshot: nil, notice: notice, offline: false, demonstration: false)
        }
        guard let choice = configuration.group?.choice else { return empty("Затисніть віджет → «Змінити віджет» → оберіть групу.") }
        do {
            let client = try XelayClient()
            guard let identity = try await client.identity() else { return empty(XelayError.signedOut.userMessage) }
            guard identity.accountID == choice.accountID else { return empty("Цей віджет належить іншому акаунту. Змініть групу в налаштуваннях.") }
            var snapshot: WidgetSnapshot
            var offline = false
            do { snapshot = try await client.snapshot(for: choice) }
            catch {
                guard canUseOfflineCache(error), let cached = try await client.cachedSnapshot(for: choice) else { throw error }
                snapshot = cached; offline = true
            }
            // Logout/account replacement during an ordinary network request must
            // not republish its private result, even for the same user UUID.
            guard try await client.identity() == identity else { return empty(XelayError.sessionChanged.userMessage) }
            return StudyWidgetEntry(date: Date(), choice: GroupChoice(accountID: choice.accountID, group: snapshot.group), mode: mode,
                theme: configuration.theme, snapshot: snapshot, notice: nil, offline: offline, demonstration: false)
        } catch {
            return empty((error as? XelayError)?.userMessage ?? "Не вдалося оновити дані. Відкрийте Xelay й спробуйте ще раз.")
        }
    }
}
