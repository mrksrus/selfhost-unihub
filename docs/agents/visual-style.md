# Visual style

Part of the [agent guide](../../AGENTS.md). Read it, with [UI acceptance](../UI_ACCEPTANCE.md), before changing anything a person sees.


- Preserve UniHub's black, white, and blue identity unless the task asks for a redesign. Dark is the default; Light and System must also work. Use the semantic CSS variables in src/index.css through Tailwind classes, including the existing module and success/warning/destructive colors. Avoid hard-coded colors in feature views.
- Use Inter for interface text and JetBrains Mono where code or fixed-width data helps. Keep headings and actions in plain, sentence-case language. Let spacing, type, and alignment show hierarchy; add borders, cards, gradients, or motion only when they clarify a real distinction.
- Reuse src/components/ui/ controls and their variants. Keep feature-specific layout in the feature component. Do not create a new visual treatment for a common control when an existing variant fits.
- Pages use `PageShell`: a navigation rail and an optional context panel on wide screens (foldable from its header, remembered per browser and page); on narrow screens the page header is the top bar, the panel opens as a sheet, and a bottom bar navigates. Prefer rows to cards and one main action per row. Check both widths, long content, scrolling, touch targets, and safe-area clearance. A change should remain usable with keyboard focus, visible errors, useful empty/loading states, sufficient contrast, and reduced motion.
- Treat displayed email as untrusted content. Keep SafeEmailContent and its privacy controls in charge of HTML mail and remote images; do not render sender HTML as ordinary application UI.
- The default dark and light palettes are the identity. The per-device looks (OLED black, High contrast, Colour-safe, Neon, Paper, ...) are listed in src/lib/theme.ts and defined as `[data-theme]` blocks in src/index.css; the account accent (src/lib/accent.ts) is written inline on `<html>` and must keep working on top of every look.
