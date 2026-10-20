import SwiftUI
import WidgetKit

@main
struct XelayWidgetBundle: WidgetBundle {
    var body: some Widget { XelayScheduleWidget(); XelayDeadlinesWidget() }
}
struct XelayScheduleWidget: Widget {
    let kind = "XelaySchedule"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: StudyWidgetIntent.self, provider: StudyWidgetProvider(mode: .schedule)) { StudyWidgetView(entry: $0) }
            .configurationDisplayName("Зараз і наступні пари")
            .description("Поточна пара — помаранчева. Далі — найближчі заняття вашої групи за часом Києва.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
struct XelayDeadlinesWidget: Widget {
    let kind = "XelayDeadlines"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: StudyWidgetIntent.self, provider: StudyWidgetProvider(mode: .homework)) { StudyWidgetView(entry: $0) }
            .configurationDisplayName("Найближче ДЗ")
            .description("Найближчі завдання групи та викладачів. Група й тема обираються окремо для кожного віджета.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
