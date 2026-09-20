package dev.clauderemote.android.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Catppuccin Macchiato color palette
 * https://github.com/catppuccin/catppuccin
 */
object CatppuccinMacchiato {
    // Base colors
    val Base = Color(0xFF24273A)        // Main background
    val Mantle = Color(0xFF1E2030)      // Deeper background
    val Crust = Color(0xFF181926)       // Deepest background

    // Surface colors
    val Surface0 = Color(0xFF363A4F)
    val Surface1 = Color(0xFF494D64)
    val Surface2 = Color(0xFF5B6078)

    // Overlay colors
    val Overlay0 = Color(0xFF6E738D)
    val Overlay1 = Color(0xFF8087A2)
    val Overlay2 = Color(0xFF939AB7)

    // Text colors
    val Text = Color(0xFFCAD3F5)        // Primary text
    val Subtext1 = Color(0xFFB8C0E0)    // Secondary text
    val Subtext0 = Color(0xFFA5ADCB)    // Tertiary text

    // Accent colors
    val Lavender = Color(0xFFB7BDF8)    // Primary accent
    val Blue = Color(0xFF8AADF4)
    val Sapphire = Color(0xFF7DC4E4)
    val Sky = Color(0xFF91D7E3)
    val Teal = Color(0xFF8BD5CA)
    val Green = Color(0xFFA6DA95)
    val Yellow = Color(0xFFEED49F)
    val Peach = Color(0xFFF5A97F)
    val Maroon = Color(0xFFEE99A0)
    val Red = Color(0xFFED8796)
    val Mauve = Color(0xFFC6A0F6)       // Secondary accent
    val Pink = Color(0xFFF5BDE6)
    val Flamingo = Color(0xFFF0C6C6)
    val Rosewater = Color(0xFFF4DBD6)
}

/**
 * Semantic color mapping for the app - darker variant
 */
object AppColors {
    // Backgrounds - much darker
    val Background = CatppuccinMacchiato.Crust           // #181926 (deepest)
    val BackgroundDeep = CatppuccinMacchiato.Mantle      // #1E2030
    val BackgroundDeepest = Color(0xFF0D0E14)            // Even darker than Crust

    // Surfaces - darker hierarchy
    val Surface = CatppuccinMacchiato.Mantle             // #1E2030
    val SurfaceElevated = CatppuccinMacchiato.Base       // #24273A
    val SurfaceHigh = CatppuccinMacchiato.Surface0       // #363A4F

    // Text
    val TextPrimary = CatppuccinMacchiato.Text
    val TextSecondary = CatppuccinMacchiato.Subtext1
    val TextTertiary = CatppuccinMacchiato.Subtext0

    // Accent
    val Primary = CatppuccinMacchiato.Lavender
    val PrimaryVariant = CatppuccinMacchiato.Mauve
    val Secondary = CatppuccinMacchiato.Blue

    // Semantic states
    val Success = CatppuccinMacchiato.Green
    val Warning = CatppuccinMacchiato.Yellow
    val Error = CatppuccinMacchiato.Red
    val Info = CatppuccinMacchiato.Sapphire

    // Interactive
    val Link = CatppuccinMacchiato.Blue
    val CodeBackground = Color(0xFF0D0E14)               // Darker than Mantle
    val CodeText = CatppuccinMacchiato.Sky

    // Borders & dividers - more subtle
    val Border = CatppuccinMacchiato.Surface1
    val Divider = CatppuccinMacchiato.Surface0
}
