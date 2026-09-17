# Design

## Surface

Compact Chinese operational console, white content, neutral sidebar, teal active navigation.
The first screen is the actual request monitor, not a landing page.

## Palette

- Background: oklch(1 0 0)
- Secondary surface: oklch(0.975 0 0)
- Ink: oklch(0.25 0.012 200)
- Muted: oklch(0.48 0.012 200)
- Primary: oklch(0.45 0.08 200)
- Warning: oklch(0.46 0.10 65)
- Danger: oklch(0.48 0.16 25)
- Accent info: oklch(0.45 0.11 255)

## Type

System UI, Microsoft YaHei for Chinese. Fixed 14px base, 24px page headings.
Tabular numeric data. No negative letter spacing.

## Components

Flat metric band; unframed sections; compact data tables; 6px inputs and buttons.
Explicit text status with semantic color. Primary commands use icon and text.
Login form is the only initial framed panel.

## Responsive

Sidebar becomes horizontal navigation under 820px.
Tables scroll inside their own region; document never scrolls sideways.
Settings become one column; controls remain full-sized.
