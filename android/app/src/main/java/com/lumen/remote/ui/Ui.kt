package com.lumen.remote.ui

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** Shared palette and small view builders, mirroring the desktop dark theme. */
object Theme {
    val BG = Color.parseColor("#0b0d13")
    val CARD = Color.parseColor("#12161f")
    val CARD_BORDER = Color.parseColor("#1e2532")
    val TEXT = Color.parseColor("#eef2fa")
    val TEXT_DIM = Color.parseColor("#8b93a5")
    val ACCENT = Color.parseColor("#5b8cff")
    val ACCENT_DIM = Color.parseColor("#7ea6ff")
    val OK = Color.parseColor("#31c48d")
    val WARN = Color.parseColor("#fbbf24")
    val DANGER = Color.parseColor("#f16a6a")
}

fun Context.dp(value: Float): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics).toInt()

fun roundedBackground(
    fill: Int,
    radiusDp: Float,
    stroke: Int? = null,
    strokeWidthDp: Float = 1f,
    context: Context,
): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = context.dp(radiusDp).toFloat()
    setColor(fill)
    if (stroke != null) setStroke(context.dp(strokeWidthDp), stroke)
}

fun Context.card(radius: Float = 16f): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    background = roundedBackground(Theme.CARD, radius, Theme.CARD_BORDER, 1f, this@card)
    setPadding(dp(16f), dp(14f), dp(16f), dp(16f))
}

fun Context.label(text: String): TextView = TextView(this).apply {
    this.text = text
    setTextColor(Theme.TEXT_DIM)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
}

fun Context.heading(text: String, size: Float = 15f): TextView = TextView(this).apply {
    this.text = text
    setTextColor(Theme.TEXT)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    setTypeface(typeface, android.graphics.Typeface.BOLD)
}

fun Context.body(text: String, color: Int = Theme.TEXT_DIM, size: Float = 12.5f): TextView = TextView(this).apply {
    this.text = text
    setTextColor(color)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
}

fun Context.mono(text: String, size: Float = 26f, color: Int = Theme.TEXT): TextView = TextView(this).apply {
    this.text = text
    setTextColor(color)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    letterSpacing = 0.08f
    typeface = android.graphics.Typeface.MONOSPACE
    setTypeface(typeface, android.graphics.Typeface.BOLD)
}

fun Context.input(hintText: String, inputType: Int = android.text.InputType.TYPE_CLASS_TEXT): EditText =
    EditText(this).apply {
        hint = hintText
        setHintTextColor(Theme.TEXT_DIM)
        setTextColor(Theme.TEXT)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        this.inputType = inputType
        background = roundedBackground(Color.parseColor("#0e1219"), 10f, Theme.CARD_BORDER, 1f, this@input)
        setPadding(dp(12f), dp(11f), dp(12f), dp(11f))
        isSingleLine = true
    }

fun Context.primaryButton(text: String): Button = Button(this).apply {
    this.text = text
    isAllCaps = false
    setTextColor(Color.WHITE)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    background = roundedBackground(Theme.ACCENT, 10f, context = this@primaryButton)
    setPadding(dp(18f), dp(11f), dp(18f), dp(11f))
    stateListAnimator = null
}

fun Context.ghostButton(text: String): Button = Button(this).apply {
    this.text = text
    isAllCaps = false
    setTextColor(Theme.TEXT)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    background = roundedBackground(Color.parseColor("#1a2030"), 10f, Theme.CARD_BORDER, 1f, this@ghostButton)
    setPadding(dp(14f), dp(9f), dp(14f), dp(9f))
    stateListAnimator = null
}

fun Context.row(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
}

fun spacer(context: Context, heightDp: Float): View = View(context).apply {
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dp(heightDp))
}

fun horizontalLine(context: Context): View = View(context).apply {
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dp(1f)).apply {
        topMargin = context.dp(12f)
        bottomMargin = context.dp(12f)
    }
    setBackgroundColor(Theme.CARD_BORDER)
}
