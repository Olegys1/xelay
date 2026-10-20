import SwiftUI

struct WidgetPalette {
    let background: Color; let row: Color; let primary: Color; let secondary: Color; let accent: Color
    static func colors(_ theme: WidgetTheme, scheme: ColorScheme) -> WidgetPalette {
        let resolved = theme == .system ? (scheme == .dark ? WidgetTheme.dark : .light) : theme
        switch resolved {
        case .dark:
            return WidgetPalette(background: Color(red: 0.09, green: 0.10, blue: 0.14), row: Color.white.opacity(0.07), primary: .white,
                secondary: Color.white.opacity(0.66), accent: Color(red: 1, green: 0.67, blue: 0.45))
        case .halloween:
            return WidgetPalette(background: Color(red: 0.11, green: 0.07, blue: 0.17), row: Color(red: 0.21, green: 0.14, blue: 0.28), primary: Color(red: 1, green: 0.96, blue: 0.88),
                secondary: Color(red: 0.77, green: 0.70, blue: 0.84), accent: Color(red: 1, green: 0.65, blue: 0.28))
        default:
            return WidgetPalette(background: Color(red: 0.99, green: 0.97, blue: 0.94), row: .white, primary: Color(red: 0.18, green: 0.16, blue: 0.18),
                secondary: Color(red: 0.45, green: 0.41, blue: 0.44), accent: Color(red: 0.53, green: 0.05, blue: 0.19))
        }
    }
    static let currentBackground = Color(red: 1, green: 0.60, blue: 0.22)
    static let currentText = Color(red: 0.18, green: 0.09, blue: 0.03)
}
