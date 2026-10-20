import SwiftUI
import WidgetKit
import AppIntents

struct StudyWidgetView: View {
    let entry: StudyWidgetEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme
    private var colors: WidgetPalette { .colors(entry.theme, scheme: scheme) }
    private var limit: Int { family == .systemSmall ? 1 : family == .systemMedium ? 2 : 4 }
    private var validSnapshot: WidgetSnapshot? { entry.snapshot.flatMap { $0.isFresh(at: entry.date) ? $0 : nil } }
    private var destination: URL { entry.choice.map { DeepLinks.appURL(for: $0, mode: entry.mode) } ?? DeepLinks.appHome }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemMedium ? 8 : 6) {
            header
            if let snapshot = validSnapshot {
                if family != .systemMedium {
                    Text(snapshot.group.label).font(.system(size: 10, weight: .medium)).foregroundStyle(colors.secondary).lineLimit(1).privacySensitive()
                }
                if entry.mode == .schedule { schedule(snapshot) } else { deadlines(snapshot) }
                Spacer(minLength: 0)
                HStack(spacing: 3) {
                    if entry.demonstration { Text("Приклад") }
                    else {
                        Text("Оновлено \(KyivClock.formatted(snapshot.generatedAt, "HH:mm"))")
                        if entry.offline { Text("· офлайн") }
                    }
                    Spacer(minLength: 0)
                    if entry.mode == .schedule ? snapshot.upcomingTruncated == true : snapshot.truncated {
                        Text("Ще на сайті").lineLimit(1)
                    }
                }.font(.system(size: 10)).foregroundStyle(colors.secondary)
            } else {
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 7) {
                    Image(systemName: entry.choice == nil ? "slider.horizontal.3" : "arrow.clockwise.circle").font(.title2).foregroundStyle(colors.accent)
                    Text(entry.notice ?? "Дані застаріли. Натисніть ↻ або відкрийте Xelay для оновлення.")
                        .font(.system(size: family == .systemSmall ? 12 : 14)).foregroundStyle(colors.secondary).lineLimit(family == .systemSmall ? 4 : 5)
                }
                Spacer(minLength: 0)
                Text("Відкрити Xelay ↗").font(.caption.weight(.semibold)).foregroundStyle(colors.accent)
            }
        }
        .containerBackground(for: .widget) { colors.background }
        .widgetURL(destination)
    }
    private var header: some View {
        HStack(alignment: .center, spacing: 6) {
            Text(entry.theme == .halloween ? "🎃" : "X").font(.system(size: 21, weight: .medium, design: .serif)).foregroundStyle(colors.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.mode == .schedule ? "Зараз і далі" : "Найближче ДЗ").font(.system(size: family == .systemSmall ? 13 : 15, weight: .bold)).lineLimit(1)
                if family != .systemSmall {
                    Text(validSnapshot?.group.label ?? "Xelay · час Києва").font(.system(size: 9)).foregroundStyle(colors.secondary).lineLimit(1).privacySensitive()
                }
            }.foregroundStyle(colors.primary)
            Spacer(minLength: 0)
            Button(intent: RefreshWidgetIntent(mode: entry.mode.rawValue)) {
                Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold)).foregroundStyle(colors.accent)
                    .frame(width: 28, height: 28).background(colors.row, in: Circle())
            }.buttonStyle(.plain).accessibilityLabel("Запросити оновлення")
        }
    }
    @ViewBuilder private func schedule(_ snapshot: WidgetSnapshot) -> some View {
        if snapshot.upcomingSchemaVersion == nil {
            emptyText("Для поточних пар потрібно оновити серверні дані. Натисніть ↻.")
        } else if !snapshot.upcomingValid(at: entry.date) {
            emptyText("Період розкладу завершився. Оновіть дані.")
        } else {
            let rows = snapshot.nextLessons(at: entry.date)
            if rows.isEmpty {
                emptyText(snapshot.upcomingTruncated == true ? "Оновіть дані, щоб побачити наступні пари." : "До \(snapshot.upcomingWindowEnd.flatMap(KyivClock.parseDay).map { KyivClock.formatted($0, "d MMM") } ?? "кінця періоду") пар немає.")
            } else {
                if family == .systemMedium {
                    HStack(alignment: .top, spacing: 8) {
                        ForEach(Array(rows.prefix(limit))) { lessonCard($0) }
                    }
                } else {
                    ForEach(Array(rows.prefix(limit))) { lessonCard($0) }
                }
            }
        }
    }
    @ViewBuilder private func deadlines(_ snapshot: WidgetSnapshot) -> some View {
        let rows = snapshot.deadlines.filter { $0.isUpcoming(at: entry.date) }
        if rows.isEmpty { emptyText("Найближчих завдань із терміном здачі немає.") }
        else {
            if family == .systemMedium {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(rows.prefix(limit)), id: \.rowID) { deadlineCard($0) }
                }
            } else {
                ForEach(Array(rows.prefix(limit)), id: \.rowID) { deadlineCard($0) }
            }
        }
    }
    private func lessonCard(_ row: LessonOccurrence) -> some View {
        let current = row.isCurrent(at: entry.date)
        return linked(row.url) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if current { Circle().fill(WidgetPalette.currentText).frame(width: 5, height: 5) }
                    Text(current ? (family == .systemLarge ? "ЗАРАЗ ІДЕ ПАРА" : "ЗАРАЗ") : KyivClock.dateLabel(row.lessonDate, now: entry.date).uppercased())
                        .font(.system(size: 9, weight: .bold)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text("\(row.startTime)–\(row.endTime)").font(.system(size: 10, weight: .semibold)).monospacedDigit().lineLimit(1)
                }.foregroundStyle(current ? WidgetPalette.currentText : colors.secondary)
                Text(row.title).font(.system(size: family == .systemSmall ? 13 : 14, weight: .semibold)).lineLimit(family == .systemLarge ? 1 : 2)
                    .foregroundStyle(current ? WidgetPalette.currentText : colors.primary)
                if family == .systemLarge, let location = row.location, !location.isEmpty {
                    Text(location).font(.system(size: 10)).lineLimit(1).foregroundStyle(current ? WidgetPalette.currentText.opacity(0.8) : colors.secondary)
                }
            }.padding(family == .systemLarge ? 6 : 8).frame(maxWidth: .infinity, alignment: .leading)
                .background(current ? WidgetPalette.currentBackground : colors.row, in: RoundedRectangle(cornerRadius: 12)).privacySensitive()
        }
    }
    private func deadlineCard(_ row: Deadline) -> some View {
        linked(row.url) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Image(systemName: row.source == "teaching" ? "graduationcap" : "checklist")
                    Text(deadlineLabel(row)).lineLimit(1)
                }.font(.system(size: 10, weight: .semibold)).foregroundStyle(colors.accent)
                Text(row.title).font(.system(size: family == .systemSmall ? 13 : 14, weight: .semibold)).foregroundStyle(colors.primary).lineLimit(family == .systemLarge ? 1 : 2)
                if family != .systemSmall, let subject = row.subject, !subject.isEmpty { Text(subject).font(.system(size: 10)).foregroundStyle(colors.secondary).lineLimit(1) }
            }.padding(family == .systemLarge ? 6 : 8).frame(maxWidth: .infinity, alignment: .leading).background(colors.row, in: RoundedRectangle(cornerRadius: 12)).privacySensitive()
        }
    }
    private func deadlineLabel(_ row: Deadline) -> String {
        let date = KyivClock.dateLabel(row.dueDate, now: entry.date)
        return row.dueAt.map { date + " до " + KyivClock.formatted($0, "HH:mm") } ?? date + " · без точного часу"
    }
    private func emptyText(_ value: String) -> some View { Text(value).font(.callout).foregroundStyle(colors.secondary).fixedSize(horizontal: false, vertical: true).lineLimit(4) }
    @ViewBuilder private func linked<Content: View>(_ url: URL, @ViewBuilder content: () -> Content) -> some View {
        if family != .systemSmall, let choice = entry.choice {
            Link(destination: DeepLinks.appURL(for: choice, mode: entry.mode, destination: url), label: content).buttonStyle(.plain)
        } else { content() }
    }
}
