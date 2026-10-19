package ink.xelay.android.widget

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import ink.xelay.android.data.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

open class XelayWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { WidgetUpdates.renderSafely(context, it) }
        if (!WidgetUpdates.enqueue(context)) {
            ids.forEach { WidgetUpdates.renderSafely(context, it, WidgetUpdates.SCHEDULE_FAILURE) }
        }
        runCatching { WidgetBoundaries.reconcile(context) }
    }
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        WidgetUpdates.renderSafely(context, id)
        WidgetUpdates.ensurePeriodic(context)
        runCatching { WidgetBoundaries.reconcile(context) }
    }
    override fun onDeleted(context: Context, ids: IntArray) {
        ids.forEach { runCatching { PrivateStore(context).unbind(it) } }
        WidgetUpdates.ensurePeriodic(context)
        runCatching { WidgetBoundaries.reconcile(context) }
    }
    override fun onRestored(context: Context, oldWidgetIds: IntArray, newWidgetIds: IntArray) {
        // Restored widgets have no backed-up credentials or private academic data.
        oldWidgetIds.forEach { runCatching { PrivateStore(context).unbind(it) } }
        newWidgetIds.forEach { WidgetUpdates.renderSafely(context, it) }
        WidgetUpdates.ensurePeriodic(context)
        runCatching { WidgetBoundaries.reconcile(context) }
    }
    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == WidgetUpdates.ACTION_REFRESH) {
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            if (id in runCatching { WidgetRenderer.ids(context) }.getOrDefault(intArrayOf())) {
                // Queueing is not execution. A deferred job must not leave a
                // permanent loading caption while waiting for network or quota.
                WidgetUpdates.renderSafely(context, id, "Оновлення запитано · очікуємо мережу")
                if (!WidgetUpdates.enqueue(context, urgent = true)) {
                    WidgetUpdates.renderSafely(context, id, WidgetUpdates.SCHEDULE_FAILURE)
                }
                runCatching { WidgetBoundaries.reconcile(context) }
            }
        }
    }
}
class ScheduleWidgetProvider : XelayWidgetProvider()
class DeadlinesWidgetProvider : XelayWidgetProvider()

object WidgetUpdates {
    const val ACTION_REFRESH = "ink.xelay.android.REFRESH_WIDGET"
    const val SCHEDULE_FAILURE = "Не вдалося запланувати оновлення · відкрийте Xelay"
    private const val IMMEDIATE_JOB_ID = 27401
    private const val PERIODIC_JOB_ID = 27402
    private const val PERIOD_MILLIS = 60 * 60 * 1000L
    private var requested = 0L
    private var urgentRequested = 0L
    private var runSequence = 0L
    private val running = mutableMapOf<Int, Long>()

    data class Run internal constructor(val jobId: Int, val serial: Long, val baseline: Long)

    private fun eligible(context: Context): Boolean = runCatching {
        PrivateStore(context).sessionForRequest() != null && WidgetRenderer.ids(context).isNotEmpty()
    }.getOrDefault(false)

    /** Register once: re-registering on each repaint would reset the period. */
    @Synchronized fun ensurePeriodic(context: Context): Boolean {
        return try {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (!eligible(context)) {
                scheduler.cancel(PERIODIC_JOB_ID)
                return false
            }
            val existing = scheduler.getPendingJob(PERIODIC_JOB_ID)
            if (existing != null && existing.isPeriodic && existing.isPersisted && existing.intervalMillis == PERIOD_MILLIS) return true
            scheduler.schedule(JobInfo.Builder(PERIODIC_JOB_ID, ComponentName(context, WidgetUpdateService::class.java))
                .setPeriodic(PERIOD_MILLIS).setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build()) == JobScheduler.RESULT_SUCCESS
        } catch (_: Exception) { false }
    }

    @Synchronized fun enqueue(context: Context, urgent: Boolean = false): Boolean {
        ensurePeriodic(context)
        if (!eligible(context)) return false
        requested++
        if (urgent) urgentRequested = requested
        // Only a job that entered onStartJob can hold this marker. A merely
        // pending/deferred/cancelled job can never block a later tap.
        if (running.containsKey(IMMEDIATE_JOB_ID)) return true
        return schedule(context, 0, urgent)
    }

    private fun schedule(context: Context, offset: Int, urgent: Boolean): Boolean {
        return try {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            fun builder() = JobInfo.Builder(IMMEDIATE_JOB_ID, ComponentName(context, WidgetUpdateService::class.java))
                .setExtras(PersistableBundle().apply { putInt("offset", offset) })
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            if (urgent && Build.VERSION.SDK_INT >= 31) {
                val expedited = runCatching { scheduler.schedule(builder().setExpedited(true).build()) }
                if (expedited.getOrNull() == JobScheduler.RESULT_SUCCESS) return true
            }
            // This is a scheduling preference, not a three-second execution
            // promise. Newer Android may reject extremely short job windows.
            val job = if (urgent) runCatching { builder().setOverrideDeadline(3000L).build() }
                .getOrElse { builder().build() } else builder().build()
            val result = runCatching { scheduler.schedule(job) }.getOrDefault(JobScheduler.RESULT_FAILURE)
            if (result == JobScheduler.RESULT_SUCCESS) true
            else urgent && scheduler.schedule(builder().build()) == JobScheduler.RESULT_SUCCESS
        } catch (_: Exception) { false }
    }

    @Synchronized fun begin(jobId: Int): Run {
        val run = Run(jobId, ++runSequence, requested)
        running[jobId] = run.serial
        return run
    }

    @Synchronized fun complete(context: Context, run: Run, nextOffset: Int?, finish: () -> Unit) {
        if (running[run.jobId] == run.serial) running.remove(run.jobId)
        // A platform failure must never leave the in-memory gate locked.
        runCatching { finish() }
        if (!eligible(context) || running.containsKey(IMMEDIATE_JOB_ID)) return
        val scheduled = when {
            requested != run.baseline -> schedule(context, 0, urgentRequested > run.baseline)
            nextOffset != null -> schedule(context, nextOffset, false)
            else -> true
        }
        if (!scheduled) renderAllSafely(context, SCHEDULE_FAILURE)
    }

    @Synchronized fun stopped(run: Run) {
        if (running[run.jobId] == run.serial) running.remove(run.jobId)
    }

    @Synchronized fun cancel(context: Context) {
        requested++
        running.clear()
        runCatching {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            scheduler.cancel(IMMEDIATE_JOB_ID)
            scheduler.cancel(PERIODIC_JOB_ID)
        }
        runCatching { WidgetBoundaries.cancel(context) }
    }

    fun renderSafely(context: Context, id: Int, notice: String? = null) {
        runCatching { WidgetRenderer.renderOne(context, id, notice) }
    }
    fun renderAllSafely(context: Context, notice: String? = null) {
        runCatching { WidgetRenderer.ids(context) }.getOrDefault(intArrayOf())
            .forEach { renderSafely(context, it, notice) }
    }
}

class WidgetUpdateService : JobService() {
    private class Execution(val params: JobParameters, val run: WidgetUpdates.Run) {
        val cancelled = AtomicBoolean(false)
        val finished = AtomicBoolean(false)
        var work: Future<*>? = null
    }
    private val executions = ConcurrentHashMap<Int, Execution>()

    override fun onStartJob(params: JobParameters): Boolean {
        executions.remove(params.jobId)?.let { previous ->
            previous.cancelled.set(true)
            previous.work?.cancel(true)
            WidgetUpdates.stopped(previous.run)
        }
        val execution = Execution(params, WidgetUpdates.begin(params.jobId))
        executions[params.jobId] = execution
        return try {
            execution.work = executor.submit { update(execution) }
            true
        } catch (_: Exception) {
            executions.remove(params.jobId, execution)
            WidgetUpdates.stopped(execution.run)
            WidgetUpdates.renderAllSafely(this, WidgetUpdates.SCHEDULE_FAILURE)
            runCatching { WidgetBoundaries.reconcile(this) }
            false
        }
    }

    private fun finishOnce(execution: Execution, retry: Boolean) {
        if (execution.finished.compareAndSet(false, true)) runCatching { jobFinished(execution.params, retry) }
    }

    private fun update(execution: Execution) {
        val params = execution.params
        var retry = false
        var nextOffset: Int? = null
        var generation: Long? = null
        var store: PrivateStore? = null
        var hadSession = false
        try {
            val currentStore = PrivateStore(this)
            store = currentStore
            val session = currentStore.sessionForRequest()
            generation = currentStore.generation()
            if (session == null) {
                WidgetUpdates.renderAllSafely(this)
                return
            }
            hadSession = true
            val api = XelayApi(this)
            val bindings = WidgetRenderer.ids(this).toList().mapNotNull { id ->
                runCatching { currentStore.binding(id) }.getOrNull()
            }.filter { it.userId == session.userId }
            val groups = bindings.map { it.groupId }.distinct().sorted().take(50)
            val offset = params.extras.getInt("offset", 0).coerceIn(0, 50)
            if (offset + 8 < groups.size) nextOffset = offset + 8
            groups.drop(offset).take(8).forEach { group ->
                if (execution.cancelled.get() || currentStore.generation() != generation) return@forEach
                val widgetIds = bindings.filter { it.groupId == group }.map { it.widgetId }
                widgetIds.forEach { WidgetUpdates.renderSafely(this, it, "Оновлюємо…") }
                var notice: String? = null
                try {
                    val (_, raw) = api.snapshot(group)
                    if (!execution.cancelled.get()) currentStore.cache(session.userId, group, raw, generation!!)
                } catch (error: Exception) {
                    when {
                        error is SessionChanged -> Unit
                        error is SessionExpired -> notice = "Увійдіть у застосунку · AUTH_SESSION_EXPIRED"
                        error is SecureStorageFailure -> notice = "Відкрийте застосунок · AUTH_STORAGE"
                        error is ApiFailure && error.operation == ApiOperation.DATA && error.status == 403 -> {
                            currentStore.forgetGroup(session.userId, group, generation)
                            notice = "Доступ до групи змінився. Відкрийте Xelay."
                        }
                        error is ApiFailure && error.operation == ApiOperation.DATA && error.status == 401 -> {
                            currentStore.forgetGroup(session.userId, group, generation)
                            notice = "Перевірте акаунт у застосунку · WIDGET_DATA/401"
                        }
                        error is ApiFailure && error.operation == ApiOperation.REFRESH -> notice = "Відкрийте застосунок · AUTH_REFRESH"
                        error is ApiFailure && error.status == 404 -> notice = "Підключення віджетів ще готується."
                        else -> { notice = "Немає оновлення · натисніть ↻"; retry = true }
                    }
                }
                if (!execution.cancelled.get()) widgetIds.forEach { WidgetUpdates.renderSafely(this, it, notice) }
            }
        } catch (error: Throwable) {
            retry = error !is SecureStorageFailure && error !is SessionExpired && error !is SessionChanged
            if (!execution.cancelled.get()) {
                val notice = if (error is SecureStorageFailure) "Відкрийте застосунок · AUTH_STORAGE"
                    else "Не вдалося оновити віджет · відкрийте Xelay"
                WidgetUpdates.renderAllSafely(this, notice)
            }
        } finally {
            // Every exit releases only this execution, including rendering and
            // storage failures. An obsolete Future cannot cancel another job.
            if (!execution.cancelled.get() && executions.remove(params.jobId, execution)) {
                runCatching {
                    if ((generation != null && store?.generation() != generation) || (hadSession && store?.session() == null)) {
                        WidgetUpdates.renderAllSafely(this)
                        nextOffset = null
                    }
                }
                try {
                    WidgetUpdates.complete(this, execution.run, nextOffset) { finishOnce(execution, retry) }
                } catch (_: Throwable) {
                    WidgetUpdates.stopped(execution.run)
                    finishOnce(execution, true)
                }
            } else WidgetUpdates.stopped(execution.run)
            runCatching { WidgetBoundaries.reconcile(this) }
        }
    }

    override fun onStopJob(params: JobParameters): Boolean {
        executions.remove(params.jobId)?.let { execution ->
            execution.cancelled.set(true)
            execution.work?.cancel(true)
            WidgetUpdates.stopped(execution.run)
        }
        WidgetUpdates.renderAllSafely(this, "Оновлення відкладено · натисніть ↻")
        runCatching { WidgetBoundaries.reconcile(this) }
        return runCatching { PrivateStore(this).sessionForRequest() != null && WidgetRenderer.ids(this).isNotEmpty() }.getOrDefault(false)
    }

    override fun onDestroy() {
        executions.values.forEach { execution ->
            execution.cancelled.set(true)
            execution.work?.cancel(true)
            WidgetUpdates.stopped(execution.run)
        }
        executions.clear()
        super.onDestroy()
    }

    companion object { private val executor = Executors.newFixedThreadPool(2) }
}
