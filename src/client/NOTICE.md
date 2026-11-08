# Chat recall settings controls

## Adapted shadcn/ui compositions

The Switch, RadioGroup / Radio item, and Collapsible compositions in [shadcn.tsx](./shadcn.tsx) are adapted from the official shadcn/ui **Base UI** registry through the user-supplied Dream reference. The local reference was read on 2026-11-07; its notice records an upstream inspection on 2026-11-06 and revision `c257f688cf4de7ec10cc1be84cad29cd4631182c` (the Switch's last change; reference files fetched from main). That upstream revision was not independently re-fetched for this migration.

Upstream source locations recorded by the reference:

- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/switch.tsx
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/radio-group.tsx
- https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/collapsible.tsx

Copyright (c) 2023 shadcn. The complete MIT license is copied unchanged from the supplied reference into [SHADCN_LICENSE.txt](./SHADCN_LICENSE.txt). Distributed copies containing these adapted compositions must retain that notice and license.

Migration changes: replace cn/Tailwind with local Host-token CSS; replace Dream-specific classes with Chat recall classes; namespace every data-slot with `cr-`; retain the Switch's explicitly rendered, reset native button; preserve Base UI primitive composition and support state-based className callbacks. No Radix primitives, Tailwind runtime/global reset, or Harness-private Client components are imported.

## Original wrappers and styles

The Checkbox in [ui.tsx](./ui.tsx) is an **original wrapper around Base UI Checkbox**, not a copy of the official shadcn/ui Checkbox registry component. It retains Base UI's real hidden checkbox input, focusable accessible root, and keyboard behavior. Its visible label is a separate, explicitly associated label, not a nested label. The checkmark and disclosure-chevron SVG paths are original simple UI glyphs.

Button, Input, Textarea, Field, FieldSet, Toggle and choice-card layout, Advanced layout, Notice, the Field accessibility context, and the Chat recall CSS are application wrappers/layout authored for this migration, with the supplied Dream implementation serving as the composition reference. Only the three primitive families listed above are attributed as adapted shadcn/ui registry source.

All selectors in [styles.css](./styles.css) are scoped beneath `.dsh-chat-recall`. Colors inherit public `--dsw-alias-*` Host theme tokens, including the semantic error/success/warn/idle tokens, so the same stylesheet follows Host light and dark themes. The controls create no portals, append nothing to `document.body`, and do not change the Host theme.

## Runtime dependencies and distribution

These sources target **Base UI `@base-ui/react` 1.9.0** and **React 18.3.1**. Base UI is an MIT-licensed project maintained by the MUI/Base UI contributors; its own distributed license must be included by the dependency/third-party-notices build. It is a dependency license, separate from the shadcn source license retained above.

React and ReactDOM must be supplied by the Harness shared module loader as externals, including their JSX/runtime entry points when used by the bundler; do not bundle a second React copy. Dependency installation, bundle generation, and profile changes are not performed by these source files.

Base UI component documentation (API contracts were checked against the supplied local 1.9.0 package declarations/source):

- https://base-ui.com/react/components/checkbox
- https://base-ui.com/react/components/switch
- https://base-ui.com/react/components/radio-group
- https://base-ui.com/react/components/collapsible

Visible application text is provided by callers; these controls add no hard-coded application copy or separate locale namespace.
