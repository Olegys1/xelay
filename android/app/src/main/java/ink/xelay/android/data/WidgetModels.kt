package ink.xelay.android.data

import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

// Older Android time-zone databases predate the Kyiv spelling.
val KYIV: ZoneId = runCatching { ZoneId.of("Europe/Kyiv") }.getOrElse { ZoneId.of("Europe/Kiev") }
val WIDGET_CACHE_MAX_AGE: Duration = Duration.ofHours(6)
val WIDGET_CLOCK_SKEW: Duration = Duration.ofSeconds(90)
fun uuid(value: String): String = UUID.fromString(value).toString().also {
    require(it.equals(value, ignoreCase = true))
}
fun JSONObject.text(key: String, max: Int = 240): String =
    if (isNull(key)) "" else optString(key, "").take(max)

data class AcademicGroup(val id: String, val name: String, val course: String, val degree: String) {
    val label: String get() = listOf(name, course.takeIf { it.isNotBlank() }?.let { "$it курс" }, when (degree) {
        "bachelor" -> "Бакалаврат"; "master" -> "Магістратура"; "postgraduate" -> "Аспірантура"; else -> degree
    })
        .filterNotNull().filter { it.isNotBlank() }.joinToString(" · ")
    companion object {
        fun parse(json: JSONObject) = AcademicGroup(uuid(json.getString("id")),
            json.getString("name").take(100), json.text("course", 20), json.text("degree", 60))
    }
}
data class Lesson(val id: String, val title: String, val kind: String,
    val starts: String, val ends: String, val location: String, val url: String)

data class LessonOccurrence(val id: String, val title: String, val kind: String,
    val starts: String, val ends: String, val location: String, val url: String, val date: LocalDate,
    val startsAt: Instant, val endsAt: Instant) {
    fun isCurrent(now: Instant): Boolean = !now.isBefore(startsAt) && now.isBefore(endsAt)
}
data class Deadline(val id: String, val title: String, val subject: String,
    val dueAt: Instant?, val dueDate: LocalDate, val source: String, val url: String)
data class WidgetSnapshot(val group: AcademicGroup, val generatedAt: Instant,
    val scheduleDate: LocalDate, val lessons: List<Lesson>, val deadlines: List<Deadline>,
    val truncated: Boolean, val upcomingLessons: List<LessonOccurrence>? = null,
    val upcomingWindowStart: LocalDate? = null, val upcomingWindowEnd: LocalDate? = null,
    val upcomingTruncated: Boolean = false) {
    fun upcomingValid(now: Instant): Boolean {
        val today = now.atZone(KYIV).toLocalDate()
        val start = upcomingWindowStart ?: return false
        val end = upcomingWindowEnd ?: return false
        return upcomingLessons != null && !today.isBefore(start) && !today.isAfter(end)
    }

    /** Local presentation changes do not need another network response. */
    fun nextPresentationBoundary(now: Instant): Instant? {
        val expires = generatedAt.plus(WIDGET_CACHE_MAX_AGE)
        if (now.isBefore(generatedAt)) return generatedAt.takeIf { Duration.between(now, it) <= WIDGET_CLOCK_SKEW }
        if (!expires.isAfter(now)) return null
        val boundaries = mutableListOf(expires,
            now.atZone(KYIV).toLocalDate().plusDays(1).atStartOfDay(KYIV).toInstant())
        if (upcomingValid(now)) {
            upcomingLessons.orEmpty().forEach { lesson ->
                boundaries += lesson.startsAt
                boundaries += lesson.endsAt
            }
            upcomingWindowEnd?.let { boundaries += it.plusDays(1).atStartOfDay(KYIV).toInstant() }
        }
        deadlines.forEach { deadline ->
            boundaries += deadline.dueAt ?: deadline.dueDate.plusDays(1).atStartOfDay(KYIV).toInstant()
        }
        return boundaries.filter { it.isAfter(now) }.minOrNull()
    }

    companion object {
        fun parse(raw: String): WidgetSnapshot {
            val json = JSONObject(raw)
            require(json.getInt("schema_version") == 1 && json.getString("timezone") == "Europe/Kyiv")
            val generated = Instant.parse(json.getString("generated_at"))
            val date = LocalDate.parse(json.getString("schedule_date"))
            require(date == generated.atZone(KYIV).toLocalDate().plusDays(1))
            val lessons = json.getJSONArray("lessons")
            val deadlines = json.getJSONArray("deadlines")
            require(lessons.length() <= 12 && deadlines.length() <= 5)
            val time = Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]")
            var windowStart: LocalDate? = null
            var windowEnd: LocalDate? = null
            var upcomingTruncated = false
            val upcoming = if (json.has("upcoming_schema_version") && !json.isNull("upcoming_schema_version")) {
                require(json.getInt("upcoming_schema_version") == 1)
                val start = LocalDate.parse(json.getString("upcoming_window_start"))
                val end = LocalDate.parse(json.getString("upcoming_window_end"))
                require(start == generated.atZone(KYIV).toLocalDate() && end == start.plusDays(14))
                windowStart = start
                windowEnd = end
                upcomingTruncated = json.getBoolean("upcoming_truncated")
                val rows = json.getJSONArray("upcoming_lessons")
                require(rows.length() <= 24)
                (0 until rows.length()).map { index -> rows.getJSONObject(index).let { row ->
                    val starts = row.getString("start_time")
                    val ends = row.getString("end_time")
                    val lessonDate = LocalDate.parse(row.getString("lesson_date"))
                    require(time.matches(starts) && time.matches(ends) && starts <= ends)
                    require(!lessonDate.isBefore(start) && !lessonDate.isAfter(end))
                    // Exact server instants preserve seconds and PostgreSQL's
                    // choice of offset during the autumn Kyiv clock change.
                    val startsAt = Instant.parse(row.getString("starts_at"))
                    val endsAt = Instant.parse(row.getString("ends_at"))
                    val clock = DateTimeFormatter.ofPattern("HH:mm")
                    require(startsAt.atZone(KYIV).toLocalDate() == lessonDate && endsAt.atZone(KYIV).toLocalDate() == lessonDate)
                    require(startsAt.atZone(KYIV).format(clock) == starts && endsAt.atZone(KYIV).format(clock) == ends)
                    val occurrence = LessonOccurrence(uuid(row.getString("id")), row.getString("title").take(180),
                        row.text("kind", 40), starts, ends, row.text("location", 100), row.text("url", 1200), lessonDate, startsAt, endsAt)
                    require(occurrence.title.isNotBlank() && occurrence.endsAt.isAfter(occurrence.startsAt)
                        && occurrence.endsAt.isAfter(generated))
                    occurrence
                } }.sortedWith(compareBy<LessonOccurrence> { it.startsAt }.thenBy { it.endsAt }.thenBy { it.id })
            } else null
            return WidgetSnapshot(AcademicGroup.parse(json.getJSONObject("group")), generated, date,
                (0 until lessons.length()).map { index -> lessons.getJSONObject(index).let { row ->
                    val starts = row.getString("start_time")
                    val ends = row.getString("end_time")
                    require(time.matches(starts) && time.matches(ends) && starts <= ends)
                    Lesson(row.getString("id"), row.getString("title").take(180), row.text("kind", 40),
                        starts, ends, row.text("location", 100), row.text("url", 1200))
                } }, (0 until deadlines.length()).map { index -> deadlines.getJSONObject(index).let { row ->
                    val at = row.text("due_at").takeIf { it.isNotBlank() }?.let(Instant::parse)
                    val due = LocalDate.parse(row.getString("due_date"))
                    val source = row.getString("source")
                    require(source in setOf("homework", "long_term", "teaching"))
                    require(at == null || at.atZone(KYIV).toLocalDate() == due)
                    Deadline(row.getString("id"), row.getString("title").take(180), row.text("subject", 100),
                        at, due, source, row.text("url", 1200))
                } }, json.optBoolean("truncated"), upcoming, windowStart, windowEnd, upcomingTruncated)
        }
    }
}
