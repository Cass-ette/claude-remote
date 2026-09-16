package dev.clauderemote.android.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    // Primary colors
    primary = AppColors.Primary,
    onPrimary = AppColors.BackgroundDeepest,
    primaryContainer = AppColors.PrimaryVariant.copy(alpha = 0.2f),
    onPrimaryContainer = AppColors.Primary,

    // Secondary colors
    secondary = AppColors.Secondary,
    onSecondary = AppColors.BackgroundDeepest,
    secondaryContainer = AppColors.Secondary.copy(alpha = 0.2f),
    onSecondaryContainer = AppColors.Secondary,

    // Tertiary colors
    tertiary = AppColors.Info,
    onTertiary = AppColors.BackgroundDeepest,
    tertiaryContainer = AppColors.Info.copy(alpha = 0.2f),
    onTertiaryContainer = AppColors.Info,

    // Background
    background = AppColors.Background,
    onBackground = AppColors.TextPrimary,

    // Surface hierarchy
    surface = AppColors.Surface,
    onSurface = AppColors.TextPrimary,
    surfaceVariant = AppColors.SurfaceElevated,
    onSurfaceVariant = AppColors.TextSecondary,
    surfaceTint = AppColors.Primary,

    // Surface containers (new in M3)
    surfaceContainer = AppColors.Surface,
    surfaceContainerHigh = AppColors.SurfaceHigh,
    surfaceContainerHighest = AppColors.SurfaceHigh,
    surfaceContainerLow = AppColors.BackgroundDeep,
    surfaceContainerLowest = AppColors.BackgroundDeepest,

    // Error
    error = AppColors.Error,
    onError = AppColors.BackgroundDeepest,
    errorContainer = AppColors.Error.copy(alpha = 0.2f),
    onErrorContainer = AppColors.Error,

    // Outline
    outline = AppColors.Border,
    outlineVariant = AppColors.Divider,

    // Inverse
    inverseSurface = AppColors.TextPrimary,
    inverseOnSurface = AppColors.BackgroundDeepest,
    inversePrimary = AppColors.PrimaryVariant,

    // Scrim
    scrim = AppColors.BackgroundDeepest.copy(alpha = 0.5f),
)

@Composable
fun AppTheme(
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
