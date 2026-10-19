package ink.xelay.android.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import ink.xelay.android.*
import ink.xelay.android.data.*
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

object WidgetRenderer {
    private val locale = Locale.forLanguageTag("uk-UA")
    private val rowContainers = intArrayOf(R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3)
    private val rowTitles = intArrayOf(R.id.widget_row_1_title, R.id.widget_row_2_title, R.id.widget_row_3_title)
    private val rowSubtitles = intArrayOf(R.id.widget_row_1_subtitle, R.id.widget_row_2_subtitle, R.id.widget_row_3_subtitle)
    private val rowDots = intArrayOf(R.id.widget_row_1_dot, R.id.widget_row_2_dot, R.id.widget_row_3_dot)
    private val rowLines = intArrayOf(R.id.widget_row_1_line, R.id.widget_row_2_line, R.id.widget_row_3_line)
    private data class Palette(val background: Int, val row: Int, val active: Int, val action: Int,
        val dot: Int, val activeDot: Int, val primary: Int, val text: Int, val secondary: Int,
        val border: Int, val activeText: Int, val refreshIcon: Int)
    private data class Row(val title: String, val detail: String, val url: String, val current: Boolean = false)

    private fun palette(context: Context, requested: String): Palette {
        val theme = if (requested in setOf("light", "dark", "halloween")) requested
            else if (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
        return when (theme) {
            "dark" -> Palette(R.drawable.widget_dark_background, R.drawable.widget_dark_row,
                R.drawable.widget_dark_active, R.drawable.widget_dark_action, R.drawable.widget_dark_dot,
                R.drawable.widget_dark_dot_active, R.color.widget_dark_primary, R.color.widget_dark_text,
                R.color.widget_dark_secondary, R.color.widget_dark_border, R.color.widget_dark_active_text, R.drawable.widget_dark_ic_refresh)
            "halloween" -> Palette(R.drawable.widget_halloween_background, R.drawable.widget_halloween_row,
                R.drawable.widget_halloween_active, R.drawable.widget_halloween_action, R.drawable.widget_halloween_dot,
                R.drawable.widget_halloween_dot_active, R.color.widget_halloween_primary, R.color.widget_halloween_text,
                R.color.widget_halloween_secondary, R.color.widget_halloween_border, R.color.widget_halloween_active_text, R.drawable.widget_halloween_ic_refresh)
            else -> Palette(R.drawable.widget_light_background, R.drawable.widget_light_row,
                R.drawable.widget_light_active, R.drawable.widget_light_action, R.drawable.widget_light_dot,
                R.drawable.widget_light_dot_active, R.color.widget_light_primary, R.color.widget_light_text,
                R.color.widget_light_secondary, R.color.widget_light_border, R.color.widget_light_active_text, R.drawable.widget_light_ic_refresh)
        }
    }
    /** Set every color again: a widget theme belongs to this widget, not the app or website. */
    fun applyTheme(context: Context, views: RemoteViews, theme: String) {
        val colors = palette(context, theme)
        views.setInt(R.id.widget_root, "setBackgroundResource", colors.background)
        views.setTextColor(R.id.widget_brand, context.getColor(colors.primary))
        views.setTextColor(R.id.widget_title, context.getColor(colors.text))
        listOf(R.id.widget_subtitle, R.id.widget_empty, R.id.widget_updated).forEach {
            views.setTextColor(it, context.getColor(colors.secondary))
        }
        views.setTextColor(R.id.widget_current_caption, context.getColor(colors.activeText))
        views.setTextColor(R.id.widget_open, context.getColor(colors.primary))
        views.setInt(R.id.widget_open, "setBackgroundResource", colors.action)
        views.setInt(R.id.widget_refresh, "setBackgroundResource", colors.action)
        views.setImageViewResource(R.id.widget_refresh, colors.refreshIcon)
        rowContainers.indices.forEach { index ->
            styleRow(context, views, index, false, theme)
            views.setInt(rowLines[index], "setBackgroundColor", context.getColor(colors.border))
            views.setViewVisibility(rowLines[index], View.VISIBLE)
        }
    }
    fun styleRow(context: Context, views: RemoteViews, index: Int, current: Boolean, theme: String) {
        if (index !in rowContainers.indices) return
        val colors = palette(context, theme)
        views.setInt(rowContainers[index], "setBackgroundResource", if (current) colors.active else colors.row)
        views.setInt(rowDots[index], "setBackgroundResource", if (current) colors.activeDot else colors.dot)
        views.setTextColor(rowTitles[index], context.getColor(if (current) colors.activeText else colors.text))
        views.setTextColor(rowSubtitles[index], context.getColor(if (current) colors.activeText else colors.secondary))
    }
    fun ids(context: Context): IntArray {
        val manager = AppWidgetManager.getInstance(context)
        return manager.getAppWidgetIds(ComponentName(context, ScheduleWidgetProvider::class.java)) +
            manager.getAppWidgetIds(ComponentName(context, DeadlinesWidgetProvider::class.java))
    }
    fun renderAll(context: Context) { ids(context).forEach { renderOne(context, it) } }
    fun isDeadline(context: Context, id: Int): Boolean = AppWidgetManager.getInstance(context)
        .getAppWidgetInfo(id)?.provider?.className == DeadlinesWidgetProvider::class.java.name
    fun renderOne(context: Context, id: Int, notice: String? = null) {
        val manager = AppWidgetManager.getInstance(context)
        val info = manager.getAppWidgetInfo(id) ?: return
        if (info.provider.packageName != context.packageName) return
        val deadlines = isDeadline(context, id)
        val views = RemoteViews(context.packageName, if (deadlines) R.layout.widget_deadlines else R.layout.widget_schedule)
        val store = PrivateStore(context)
        val state = store.viewState(id)
        val userId = state.userId
        val binding = state.binding
        val theme = binding?.theme ?: "system"
        applyTheme(context, views, theme)
        val height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180)
        val compact = height < 135
        val now = Instant.now()
        val today = now.atZone(KYIV).toLocalDate()
        val cachedSnapshot = binding?.let { b -> state.cached?.let { raw ->
            runCatching { WidgetSnapshot.parse(raw) }.getOrNull()?.takeIf { it.group.id == b.groupId }
        } }
        val clockIncorrect = cachedSnapshot?.let { Duration.between(now, it.generatedAt) > WIDGET_CLOCK_SKEW } == true
        val snapshot = cachedSnapshot?.takeIf {
            Duration.between(it.generatedAt, now).let { age -> age >= WIDGET_CLOCK_SKEW.negated() && age < WIDGET_CACHE_MAX_AGE }
        }
        val upcoming = snapshot?.takeIf { it.upcomingValid(now) }?.upcomingLessons.orEmpty()
            .filter { it.endsAt.isAfter(now) }
            .sortedWith(compareBy<LessonOccurrence> { it.startsAt }.thenBy { it.endsAt }.thenBy { it.id })
        views.setTextViewText(R.id.widget_title, if (compact) { if (deadlines) "ДЗ" else "Пари" }
            else if (deadlines) "Найближче ДЗ" else "Найближчі пари")
        val groupLabel = binding?.groupLabel ?: "Оберіть навчальну групу"
        val compactGroup = snapshot?.group?.let { group ->
            group.name + group.course.takeIf { it.isNotBlank() }?.let { "·${it}к" }.orEmpty()
        } ?: binding?.groupLabel?.substringBefore(" · ") ?: "Оберіть групу"
        views.setTextViewText(R.id.widget_subtitle, if (compact) compactGroup else groupLabel)
        views.setContentDescription(R.id.widget_subtitle, groupLabel)
        rowContainers.forEach { views.setViewVisibility(it, View.GONE) }
        views.setViewVisibility(R.id.widget_current_caption, View.GONE)
        views.setViewVisibility(R.id.widget_empty, View.VISIBLE)
        views.setTextViewText(R.id.widget_updated, "")
        views.setTextViewText(R.id.widget_open, if (binding == null) "Налаштувати →" else "Відкрити →")
        val configure = pending(context, id, "configure", Intent(context, WidgetConfigActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
        val open = if (userId == null || binding == null) configure else link(context, id, "group", groupUrl(binding.groupId))
        views.setOnClickPendingIntent(R.id.widget_root, open)
        views.setOnClickPendingIntent(R.id.widget_open, open)
        views.setOnClickPendingIntent(R.id.widget_title, configure)
        val refreshIntent = Intent(context, if (deadlines) DeadlinesWidgetProvider::class.java else ScheduleWidgetProvider::class.java)
            .setAction(WidgetUpdates.ACTION_REFRESH).setData(Uri.parse("xelay-widget://refresh/$id"))
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
        views.setOnClickPendingIntent(R.id.widget_refresh, PendingIntent.getBroadcast(context, id, refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        val empty = when {
            userId == null && notice == "Відкрийте застосунок · AUTH_STORAGE" -> notice
            userId == null -> if (compact) "Увійдіть у Xelay" else "Увійдіть у Xelay, щоб бачити свої пари та завдання."
            binding == null -> if (compact) "Оберіть групу" else "Оберіть навчальну групу для цього віджета."
            clockIncorrect -> "Перевірте дату й час на телефоні"
            snapshot == null -> notice ?: if (compact) "Натисніть ↻" else "Натисніть ↻, щоб завантажити дані."
            !deadlines && snapshot.upcomingLessons == null -> if (compact) "Оновіть розклад ↻" else "Оновіть віджет, щоб бачити поточні й наступні пари."
            !deadlines && !snapshot.upcomingValid(now) -> if (compact) "Оновіть розклад ↻" else "Період розкладу завершився. Оновіть дані кнопкою ↻."
            !deadlines && upcoming.isEmpty() && snapshot.upcomingTruncated -> if (compact) "Оновіть розклад ↻" else "Оновіть дані, щоб перевірити наступні пари."
            !deadlines && upcoming.isEmpty() -> if (compact) "Найближчих пар немає" else "До ${snapshot.upcomingWindowEnd?.format(DateTimeFormatter.ofPattern("d MMM", locale))} пар немає."
            deadlines && snapshot.deadlines.isEmpty() -> if (compact) "Дедлайнів немає" else "Найближчих завдань із терміном здачі немає."
            else -> ""
        }
        views.setTextViewText(R.id.widget_empty, empty)
        if (snapshot != null && binding != null) {
            val updated = snapshot.generatedAt.atZone(KYIV).format(DateTimeFormatter.ofPattern("HH:mm", locale))
            val age = Duration.between(snapshot.generatedAt, now).toMinutes()
            views.setTextViewText(R.id.widget_updated, notice ?: if (age >= 60) "Збережено · $updated" else "Оновлено $updated")
            val visibleRows = when { height < 180 -> 1; height < 230 -> 2; else -> 3 }
            val rows = if (!deadlines && snapshot.upcomingValid(now)) upcoming.map { lesson ->
                val date = dateLabel(lesson.date, today)
                Row(if (compact) "$date ${lesson.starts} · ${lesson.title}" else lesson.title,
                    listOf("$date · ${lesson.starts}–${lesson.ends}", lesson.location, kind(lesson.kind))
                        .filter { it.isNotBlank() }.joinToString(" · "),
                    lesson.url.ifBlank { groupUrl(binding.groupId) }, lesson.isCurrent(now))
            } else if (deadlines) snapshot.deadlines.filter { deadline ->
                deadline.dueAt?.isAfter(now) ?: !deadline.dueDate.isBefore(today)
            }.map { deadline ->
                val date = dateLabel(deadline.dueDate, today)
                val due = deadline.dueAt?.atZone(KYIV)?.format(DateTimeFormatter.ofPattern("HH:mm", locale))
                    ?.let { "$date · $it" } ?: date
                Row(if (compact) "$due · ${deadline.title}" else deadline.title,
                    listOf(due, deadline.subject).filter { it.isNotBlank() }.joinToString(" · "), deadline.url)
            } else emptyList()
            if (rows.isNotEmpty()) {
                val shown = rows.take(visibleRows)
                views.setViewVisibility(R.id.widget_empty, View.GONE)
                views.setViewVisibility(R.id.widget_current_caption, if (shown.any { it.current }) View.VISIBLE else View.GONE)
                shown.forEachIndexed { index, row ->
                    views.setViewVisibility(rowContainers[index], View.VISIBLE)
                    views.setTextViewText(rowTitles[index], row.title)
                    views.setTextViewText(rowSubtitles[index], row.detail)
                    views.setTextViewTextSize(rowTitles[index], TypedValue.COMPLEX_UNIT_SP, if (compact) 11f else 12f)
                    views.setViewVisibility(rowSubtitles[index], if (compact) View.GONE else View.VISIBLE)
                    views.setViewVisibility(rowLines[index], if (index == shown.lastIndex) View.GONE else View.VISIBLE)
                    styleRow(context, views, index, row.current, theme)
                    views.setContentDescription(rowContainers[index], listOf(if (row.current) "Пара вже триває" else "", row.title, row.detail)
                        .filter { it.isNotBlank() }.joinToString(". "))
                    views.setOnClickPendingIntent(rowContainers[index], link(context, id, "row$index", row.url))
                }
                if (rows.size > visibleRows || (if (deadlines) snapshot.truncated else snapshot.upcomingTruncated))
                    views.setTextViewText(R.id.widget_open, "Усі у Xelay →")
            } else if (empty.isBlank()) {
                views.setTextViewText(R.id.widget_empty, if (compact) "Дедлайнів немає" else "Найближчих завдань із терміном здачі немає.")
            }
        }
        store.publishIfCurrent(id, state) { manager.updateAppWidget(id, views) }
    }
    private fun dateLabel(date: LocalDate, today: LocalDate): String = when (date) {
        today -> "Сьогодні"
        today.plusDays(1) -> "Завтра"
        else -> date.format(DateTimeFormatter.ofPattern("EEE, d MMM", locale)).let { it.take(1).uppercase(locale) + it.drop(1) }
    }
    fun groupUrl(group: String) = "https://www.xelay.ink/groups/${uuid(group)}?tab=schedule"
    private fun pending(context: Context, id: Int, action: String, intent: Intent): PendingIntent =
        PendingIntent.getActivity(context, id, intent.setData(Uri.parse("xelay-widget://$action/$id")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun link(context: Context, id: Int, slot: String, url: String) = pending(context, id, slot,
        Intent(context, WidgetLinkActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id).putExtra("target", url))
    private fun kind(value: String) = when (value) {
        "lecture" -> "Лекція"; "seminar" -> "Семінар"; "practical" -> "Практичне"
        "lab" -> "Лабораторна"; "makeup" -> "Відпрацювання"; "replacement" -> "Заміна"
        "module" -> "Модуль"; "test" -> "Контрольна"; "final_assessment" -> "Підсумкова"
        "other" -> ""; else -> value.take(40)
    }
}
