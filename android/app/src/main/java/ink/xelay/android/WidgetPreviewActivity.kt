package ink.xelay.android

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.Button
import android.widget.RemoteViews
import android.widget.ScrollView
import android.widget.TextView
import ink.xelay.android.widget.WidgetRenderer

/** An explicitly labelled visual example, without a session or real academic data. */
class WidgetPreviewActivity : Activity() {
    private val themes = arrayOf("system", "light", "dark", "halloween")
    private val themeLabels = arrayOf("Як на телефоні", "Світла", "Темна", "Гелловін")
    private var theme = "system"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        theme = savedInstanceState?.getString("preview_theme").takeIf { it in themes } ?: "system"
        showPreview()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("preview_theme", theme)
        super.onSaveInstanceState(outState)
    }
    private fun showPreview() {
        val density = resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(36), dp(24), dp(32))
            setBackgroundColor(Color.rgb(240, 236, 230))
        }
        column.addView(TextView(this).apply {
            text = "Віджети Xelay"; textSize = 28f; setTextColor(Color.rgb(128, 0, 32))
        })
        column.addView(TextView(this).apply {
            text = "Приклад вигляду. Тут показані вигадані заняття й завдання. Ваші дані з’являться після входу та вибору групи."
            textSize = 15f; setTextColor(Color.DKGRAY); setPadding(0, dp(12), 0, dp(20))
        })
        column.addView(Button(this).apply {
            text = "Тема прикладу: ${themeLabels[themes.indexOf(theme)]} ▾"
            isAllCaps = false
            setOnClickListener {
                AlertDialog.Builder(this@WidgetPreviewActivity).setTitle("Тема прикладу")
                    .setSingleChoiceItems(themeLabels, themes.indexOf(theme)) { dialog, index ->
                        theme = themes[index]
                        dialog.dismiss()
                        showPreview()
                    }.setNegativeButton("Скасувати", null).show()
            }
        }, LinearLayout.LayoutParams(-1, dp(52)).apply { bottomMargin = dp(16) })
        for (deadlines in listOf(false, true)) {
            val view = RemoteViews(packageName, if (deadlines) R.layout.widget_deadlines else R.layout.widget_schedule)
            WidgetRenderer.applyTheme(this, view, theme)
            view.setTextViewText(R.id.widget_title, if (deadlines) "Найближче ДЗ" else "Найближчі пари")
            view.setTextViewText(R.id.widget_subtitle, "Приклад · 1 курс")
            view.setTextViewText(R.id.widget_updated, "Приклад даних")
            view.setViewVisibility(R.id.widget_empty, View.GONE)
            view.setViewVisibility(R.id.widget_current_caption, if (deadlines) View.GONE else View.VISIBLE)
            val containers = intArrayOf(R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3)
            val titles = intArrayOf(R.id.widget_row_1_title, R.id.widget_row_2_title, R.id.widget_row_3_title)
            val subtitles = intArrayOf(R.id.widget_row_1_subtitle, R.id.widget_row_2_subtitle, R.id.widget_row_3_subtitle)
            val lines = intArrayOf(R.id.widget_row_1_line, R.id.widget_row_2_line, R.id.widget_row_3_line)
            val names = if (deadlines) listOf("Підготувати тези", "Задачі до практичного", "Прочитати розділ 3")
                else listOf("Економічна теорія", "Вища математика", "Іноземна мова")
            val details = if (deadlines) listOf("Завтра · Економічна теорія", "За 2 дні · Вища математика", "За 3 дні · Менеджмент")
                else listOf("Сьогодні · 09:40–11:00 · ауд. 203", "Сьогодні · 11:20–12:40 · ауд. 117", "Завтра · 08:00–09:20 · Онлайн")
            view.setViewVisibility(containers[2], View.GONE)
            for (index in 0..1) {
                view.setViewVisibility(containers[index], View.VISIBLE)
                view.setTextViewText(titles[index], names[index])
                view.setTextViewText(subtitles[index], details[index])
                view.setViewVisibility(lines[index], if (index == 1) View.GONE else View.VISIBLE)
                WidgetRenderer.styleRow(this, view, index, !deadlines && index == 0, theme)
            }
            column.addView(view.apply(this, column), LinearLayout.LayoutParams(-1, dp(210)).apply { bottomMargin = dp(20) })
        }
        val scroll = ScrollView(this).apply { addView(column) }
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(scroll)
    }
}
