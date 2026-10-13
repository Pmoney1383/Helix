# Helix design reference

Source mockup: `design/home-screen.png` (dark, "luxurious gold"). Exact palette below. Implement it in `ios/Helix/DesignSystem/Theme`.

## Palette (sampled from the mockup)
Machine-readable copy: `design/tokens.json`. Keep both in sync.

| Token | Hex |
|---|---|
| bg | `#0D0E0F` |
| bgSecondary | `#0E0F11` |
| surface | `#141415` |
| surfaceElevated | `#1A1917` |
| surfaceWarm | `#261E15` |
| surfaceSecondary (dark button) | `#242321` |
| borderWarm | `#473D34` |
| gold | `#F9B94B` |
| goldHighlight | `#F9E188` |
| goldLight | `#F9D16C` |
| goldText | `#FFDC76` |
| goldActive (active tab) | `#FFDB7F` |
| goldMid | `#D68926` |
| goldDark | `#B16D18` |
| goldDeep | `#965C14` |
| onGold (text on the gold gradient) | `#2A1A05` |
| textPrimary | `#FFFFFF` |
| textSecondary | `#B8B8B8` |
| textMuted (header subtitle) | `#ADAEAF` |
| online | `#40ECBA` |
| onlineBg | `#202E27` |

**Call Claude gradient:** vertical, `#F9E188` 0%, `#F9B94B` 28%, `#D68926` 62%, `#965C14` 100%, plus a warm glow. It is not a flat fill.

## Look
- Cards use `surface` with a 1px `borderWarm` outline and ~24pt corner radius. Hero and Call Chat use `surfaceWarm` / `surfaceSecondary`.
- Gold is the single accent: primary action, active tab, "See all", glow.
- Hero card has a gold planet-horizon glow image.

## Home screen (top to bottom)
1. Header: gold orbit logo, "Helix" / "Your AI, under control.", gateway status pill.
2. Hero "AI UPDATE" card: headline, body, "Estimated completion" row, `...` menu.
3. Primary actions row: **Call Claude** and **Call Astra** as matching smoked-glass cards (`AssistantCallCard`): warm charcoal gradient, thin gold gradient border with soft bloom, champagne logo with a halo, faint gold orbit lines and nodes, dark-glass chevron. Claude gets a starburst ornament, Astra gets orbit paths.
4. Secondary actions row: **Check Status**, **Approvals**.
5. Recent list: icon tile, title, "type - time ago", chevron. "See all" link.
6. Tab bar: **Home, Chats, Calls, Settings** (gold when active).

## Navigation
- Tabs are Home / Chats / Calls / Settings. Agents and Approvals are reached from Home (Check Status, Approvals, Recent)
  rather than their own tabs, and activity history lives under Calls or Chats.

## Deviations from the mockup
- **Call Astra** replaces the mockup's **Call Chat**: it starts a voice call to the Codex front door (`POST /v1/calls/start {provider:"codex"}`), subtitle "Talk to Codex".
- The tab bar is the system Liquid Glass tab bar tinted `goldActive`, not a custom bar.
- Call Claude is no longer a solid gold card; both call cards share the dark smoked-glass style above, so gold stays an accent rather than a fill.
- Any text placed on a gold fill uses `onGold`, not white (white on `gold` is about 1.7:1).
- App icon: `icon.png` cropped to the artwork inside its drawn rounded square, so iOS's own mask replaces the black canvas and drawn border.

## Code mapping
- Tokens (colors, radii, spacing, type): `ios/Helix/DesignSystem/Theme`
- Reusable views (GoldButton, GlassCard, StatusPill, RecentRow, HeroCard): `ios/Helix/DesignSystem/Components`
- Screens: `ios/Helix/Features/<Tab>`
