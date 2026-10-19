package ink.xelay.android.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import ink.xelay.android.data.*
import java.time.Instant
import java.time.LocalDate

/** Redraw from the encrypted snapshot at the next start/end/date boundary.
 * Inexact alarms need no exact-alarm permission; Android can defer them in Doze. */
object WidgetBoundaries {
    const val ACTION = "ink.xelay.android.WIDGET_BOUNDARY"
    private const val REQUEST = 27403
    private fun pending(context: Context) = PendingIntent.getBroadcast(context, REQUEST,
        Intent(context, WidgetBoundaryReceiver::class.java).setAction(ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun reconcile(context: Context) {
        runCatching {
            val store = PrivateStore(context)
            val ids = WidgetRenderer.ids(context)
            if (store.session() == null || ids.isEmpty()) { cancel(context); return }
            val now = Instant.now()
            val midnight = LocalDate.now(KYIV).plusDays(1).atStartOfDay(KYIV).toInstant()
            val next = ids.toList().mapNotNull { id ->
                val state = store.viewState(id)
                state.cached?.let { raw -> runCatching { WidgetSnapshot.parse(raw) }.getOrNull() }
                    ?.takeIf { it.group.id == state.binding?.groupId }
                    ?.nextPresentationBoundary(now)
            }.plus(midnight).filter { it.isAfter(now) }.minOrNull() ?: midnight
            // Avoid an immediately recurring alarm around a rounded server time.
            val whenMillis = maxOf(next.toEpochMilli() + 1000L, System.currentTimeMillis() + 5000L)
            context.getSystemService(AlarmManager::class.java)
                .setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMillis, pending(context))
        }
    }

    fun cancel(context: Context) {
        runCatching { context.getSystemService(AlarmManager::class.java).cancel(pending(context)) }
    }
}

class WidgetBoundaryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(WidgetBoundaries.ACTION, Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED)) return
        runCatching { WidgetRenderer.renderAll(context) }
        WidgetBoundaries.reconcile(context)
        WidgetUpdates.ensurePeriodic(context)
        // Keep background data current, while the local redraw above does not
        // need a connection to mark a cached pair as started or finished.
        WidgetUpdates.enqueue(context)
    }
}
