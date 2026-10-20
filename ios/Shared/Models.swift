import Foundation

enum WidgetMode: String, Codable { case schedule, homework }
enum WidgetTheme: String, Codable, CaseIterable {
    case system, light, dark, halloween
    var label: String {
        switch self {
        case .system: return "Як на iPhone"
        case .light: return "Світла"
        case .dark: return "Темна"
        case .halloween: return "Гелловін"
        }
    }
}

enum KyivClock {
    static let zone = TimeZone(identifier: "Europe/Kyiv") ?? TimeZone(identifier: "Europe/Kiev")!
    static var calendar: Calendar { var value = Calendar(identifier: .gregorian); value.timeZone = zone; return value }
    static func day(_ date: Date) -> String { formatted(date, "yyyy-MM-dd", locale: "en_US_POSIX") }
    static func formatted(_ date: Date, _ pattern: String, locale: String = "uk_UA") -> String {
        let formatter = DateFormatter(); formatter.calendar = calendar; formatter.timeZone = zone
        formatter.locale = Locale(identifier: locale); formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
    static func parseDay(_ value: String) -> Date? {
        guard value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { return nil }
        let formatter = DateFormatter(); formatter.calendar = calendar; formatter.timeZone = zone
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let result = formatter.date(from: value), day(result) == value else { return nil }; return result
    }
    static func addingDays(_ count: Int, to date: Date) -> Date { calendar.date(byAdding: .day, value: count, to: date)! }
    static func nextMidnight(after date: Date) -> Date { addingDays(1, to: calendar.startOfDay(for: date)) }
    static func validTime(_ value: String) -> Bool { value.range(of: "^([01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil }
    static func dateLabel(_ day: String, now: Date) -> String {
        if day == self.day(now) { return "Сьогодні" }
        if day == self.day(addingDays(1, to: now)) { return "Завтра" }
        return parseDay(day).map { formatted($0, "EE, d MMM") } ?? day
    }
}

enum WireJSON {
    static func decoder() -> JSONDecoder {
        let result = JSONDecoder()
        result.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: raw) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: raw) { return date }
            throw XelayError.invalidResponse
        }; return result
    }
    static func encoder() -> JSONEncoder {
        let result = JSONEncoder()
        result.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer(); try container.encode(formatter.string(from: date))
        }; return result
    }
}

struct Account: Codable, Equatable { let id: UUID; let email: String }
struct SessionIdentity: Equatable { let epoch: UUID; let accountID: UUID; let cacheEpoch: UUID }
struct AcademicGroup: Codable, Equatable, Identifiable {
    let id: UUID
    let name: String
    let course: Int?
    let degree: String?
    var label: String {
        [name, course.map { "\($0) курс" }, degree.map { ["bachelor": "Бакалавр", "master": "Магістр", "postgraduate": "Аспірантура"][$0] ?? "" }]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    func validate() throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 200,
              course == nil || (1...6).contains(course!), degree == nil || ["bachelor", "master", "postgraduate"].contains(degree!) else { throw XelayError.invalidResponse }
    }
}
struct GroupChoice: Codable, Equatable, Identifiable {
    let accountID: UUID
    let group: AcademicGroup
    var id: String { accountID.uuidString.lowercased() + "/" + group.id.uuidString.lowercased() }
    var label: String { group.label }
    static func parseID(_ value: String) -> (UUID, UUID)? {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let account = UUID(uuidString: String(parts[0])), let group = UUID(uuidString: String(parts[1])) else { return nil }
        return (account, group)
    }
}

struct Lesson: Codable, Identifiable {
    let id: UUID; let title: String; let kind: String
    let startTime: String; let endTime: String; let location: String?; let url: URL
    enum CodingKeys: String, CodingKey { case id, title, kind, startTime = "start_time", endTime = "end_time", location, url }
}
struct LessonOccurrence: Codable, Identifiable {
    let rowID: UUID; let title: String; let kind: String; let lessonDate: String
    let startTime: String; let endTime: String; let startsAt: Date; let endsAt: Date; let location: String?; let url: URL
    var id: String { lessonDate + "/" + rowID.uuidString.lowercased() }
    enum CodingKeys: String, CodingKey {
        case rowID = "id", title, kind, lessonDate = "lesson_date", startTime = "start_time", endTime = "end_time"
        case startsAt = "starts_at", endsAt = "ends_at", location, url
    }
    func isCurrent(at now: Date) -> Bool { startsAt <= now && endsAt > now }
}
struct Deadline: Codable, Identifiable {
    let id: UUID; let title: String; let subject: String?; let dueAt: Date?; let dueDate: String; let source: String; let url: URL
    enum CodingKeys: String, CodingKey { case id, title, subject, dueAt = "due_at", dueDate = "due_date", source, url }
    var rowID: String { source + "/" + id.uuidString.lowercased() }
    func isUpcoming(at now: Date) -> Bool { dueAt.map { $0 > now } ?? (dueDate >= KyivClock.day(now)) }
}

struct WidgetSnapshot: Codable {
    let schemaVersion: Int; let group: AcademicGroup; let generatedAt: Date; let timezone: String
    let scheduleDate: String; let lessons: [Lesson]; let deadlines: [Deadline]; let truncated: Bool
    let upcomingSchemaVersion: Int?; let upcomingWindowStart: String?; let upcomingWindowEnd: String?
    let upcomingLessons: [LessonOccurrence]?; let upcomingTruncated: Bool?
    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", group, generatedAt = "generated_at", timezone, scheduleDate = "schedule_date", lessons, deadlines, truncated
        case upcomingSchemaVersion = "upcoming_schema_version", upcomingWindowStart = "upcoming_window_start", upcomingWindowEnd = "upcoming_window_end"
        case upcomingLessons = "upcoming_lessons", upcomingTruncated = "upcoming_truncated"
    }
    func validate(expectedGroup: UUID) throws {
        try group.validate()
        guard schemaVersion == 1, group.id == expectedGroup, timezone == "Europe/Kyiv",
              KyivClock.parseDay(scheduleDate) != nil, scheduleDate == KyivClock.day(KyivClock.addingDays(1, to: generatedAt)),
              lessons.count <= 12, deadlines.count <= 5,
              Set(lessons.map(\.id)).count == lessons.count, Set(deadlines.map(\.rowID)).count == deadlines.count else { throw XelayError.invalidResponse }
        for row in lessons {
            guard row.title.count <= 500, KyivClock.validTime(row.startTime), KyivClock.validTime(row.endTime), row.startTime <= row.endTime,
                  DeepLinks.isGroupURL(row.url, groupID: group.id) else { throw XelayError.invalidResponse }
        }
        for row in deadlines {
            guard row.title.count <= 1000, (row.subject?.count ?? 0) <= 500, KyivClock.parseDay(row.dueDate) != nil,
                  ["homework", "long_term", "teaching"].contains(row.source),
                  row.dueAt == nil || KyivClock.day(row.dueAt!) == row.dueDate,
                  DeepLinks.isGroupURL(row.url, groupID: group.id) else { throw XelayError.invalidResponse }
        }
        if let version = upcomingSchemaVersion {
            guard version == 1, let start = upcomingWindowStart, let end = upcomingWindowEnd,
                  let startDate = KyivClock.parseDay(start), KyivClock.parseDay(end) != nil,
                  start == KyivClock.day(generatedAt), end == KyivClock.day(KyivClock.addingDays(14, to: startDate)),
                  let rows = upcomingLessons, rows.count <= 24, upcomingTruncated != nil,
                  Set(rows.map(\.id)).count == rows.count else { throw XelayError.invalidResponse }
            for row in rows {
                guard row.title.count <= 500, row.lessonDate >= start, row.lessonDate <= end,
                      KyivClock.day(row.startsAt) == row.lessonDate, KyivClock.day(row.endsAt) == row.lessonDate,
                      KyivClock.validTime(row.startTime), KyivClock.validTime(row.endTime),
                      KyivClock.formatted(row.startsAt, "HH:mm") == row.startTime, KyivClock.formatted(row.endsAt, "HH:mm") == row.endTime,
                      row.endsAt > row.startsAt, row.endsAt > generatedAt, DeepLinks.isGroupURL(row.url, groupID: group.id) else { throw XelayError.invalidResponse }
            }
        } else if upcomingLessons != nil || upcomingWindowStart != nil || upcomingWindowEnd != nil { throw XelayError.invalidResponse }
    }
    func isFresh(at now: Date) -> Bool { let age = now.timeIntervalSince(generatedAt); return age >= -90 && age < 6 * 3600 }
    func upcomingValid(at now: Date) -> Bool {
        guard isFresh(at: now), upcomingSchemaVersion == 1, let start = upcomingWindowStart, let end = upcomingWindowEnd else { return false }
        return start <= KyivClock.day(now) && KyivClock.day(now) <= end
    }
    func nextLessons(at now: Date) -> [LessonOccurrence] {
        guard upcomingValid(at: now) else { return [] }
        return (upcomingLessons ?? []).filter { $0.endsAt > now }.sorted {
            if $0.startsAt != $1.startsAt { return $0.startsAt < $1.startsAt }; return $0.id < $1.id
        }
    }
    func nextBoundaries(after now: Date) -> [Date] {
        var dates = [KyivClock.nextMidnight(after: now), generatedAt.addingTimeInterval(6 * 3600)]
        for row in upcomingLessons ?? [] { dates += [row.startsAt, row.endsAt] }
        dates += deadlines.compactMap(\.dueAt)
        return Array(Set(dates.filter { $0 > now })).sorted()
    }
}

extension WidgetSnapshot {
    // Used ONLY in the explicitly labelled preview/gallery placeholder. Never
    // written to the account cache or substituted for a real empty schedule.
    static var demo: WidgetSnapshot {
        let base = KyivClock.calendar.startOfDay(for: Date())
        let start = base.addingTimeInterval(9 * 3600 + 40 * 60)
        let second = base.addingTimeInterval(11 * 3600 + 20 * 60)
        let group = AcademicGroup(id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!, name: "МА-2", course: 1, degree: "bachelor")
        let url = URL(string: "https://www.xelay.ink/groups/\(group.id.uuidString.lowercased())?tab=schedule")!
        let rows = [
            LessonOccurrence(rowID: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!, title: "Економічна теорія", kind: "seminar", lessonDate: KyivClock.day(base), startTime: "09:40", endTime: "11:00", startsAt: start, endsAt: start.addingTimeInterval(80 * 60), location: "Аудиторія 101", url: url),
            LessonOccurrence(rowID: UUID(uuidString: "00000000-0000-4000-8000-000000000003")!, title: "Вища математика", kind: "lecture", lessonDate: KyivClock.day(base), startTime: "11:20", endTime: "12:40", startsAt: second, endsAt: second.addingTimeInterval(80 * 60), location: "Онлайн", url: url)
        ]
        return WidgetSnapshot(schemaVersion: 1, group: group, generatedAt: start, timezone: "Europe/Kyiv", scheduleDate: KyivClock.day(KyivClock.addingDays(1, to: base)), lessons: [],
            deadlines: [Deadline(id: UUID(uuidString: "00000000-0000-4000-8000-000000000004")!, title: "Підготувати відповіді до семінару", subject: "Економічна теорія", dueAt: nil, dueDate: KyivClock.day(base), source: "homework", url: url)], truncated: false,
            upcomingSchemaVersion: 1, upcomingWindowStart: KyivClock.day(base), upcomingWindowEnd: KyivClock.day(KyivClock.addingDays(14, to: base)), upcomingLessons: rows, upcomingTruncated: false)
    }
}
