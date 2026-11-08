# Design system — web/

The browser UI is one surface with one job: read a coding agent's transcript, watch
what it touches, and steer it. Everything below is the contract the CSS keeps.

## Type

| Role | Token | Size | Weight |
| --- | --- | --- | --- |
| Session title (h1) | `--fs-lg` | 20px | 700 |
| Section title (h2) | `--fs-title` | 24px | 650 |
| Section heading (h3) | `--fs-sm` | 13px | 600 |
| Message body | `--fs-base` | 15px / 1.62 | 400 |
| Interface chrome (buttons, tabs) | `--fs-xs` | 12px | 500–600 |
| Metadata (turns, model, hints) | `--fs-xs` | 12px | 400–500 |
| Code | `--fs-sm` | 13px | 400 |

- Latin: self-hosted **Fira Sans** (400/500/600/700). Code: **Fira Code** (400/500).
- CJK: self-hosted **Noto Sans SC** (400/600), matched by `unicode-range` on the CJK
  blocks only, so Latin never falls through to it.
- No external font requests. No web-font loading state: `font-display: swap` with a
  system stack behind it.
- Long-form answers wrap at the bubble width (≈75ch at 1440); no justified text.

## Color

Every surface, line and ink step is a token; the dark theme redefines tokens only.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f7f6f3` | `#16150f` | Page |
| `--panel` | `#ffffff` | `#1d1c17` | Sidebar, cards, composer |
| `--panel-soft` | `#faf9f6` | `#232119` | Hover, inset blocks |
| `--user` | `#f4f2ee` | `#2a2721` | User message bubble |
| `--line` | `#e8e5df` | `#37342c` | Default hairline |
| `--line-soft` | `#efeeea` | `#2c2a23` | Section separators |
| `--line-strong` | `#d5d1c9` | `#4a463c` | Input borders, rails |
| `--ink` | `#23241f` | `#ece8de` | Primary text |
| `--ink-2` | `#55564e` | `#bcb7aa` | Secondary text |
| `--ink-3` | `#6c6d64` | `#968f81` | Metadata |
| `--ink-4` | `#9a9b92` | `#6e6a5f` | Disabled |
| `--accent` | `#b4552f` | `#e79a6d` | Links, focus, active marks |
| `--accent-fill` | `#b4552f` | `#e79a6d` | Primary button fill |
| `--accent-soft` | `#fbeee7` | `#3a271b` | Selection wash |
| `--danger` | `#a8453a` | `#e08d80` | Errors |
| `--danger-soft` | `#fdf1ef` | `#3a211d` | Error wash |
| `--success` | `#3f7f5f` | `#74b795` | Online dot only |

Rules that keep this honest:

- **One accent.** Terracotta marks interactive and current things; nothing else uses hue.
  Green survives only as a semantic status dot, never as decoration.
- **Contrast floor.** Body text ≥ 6:1, metadata ≥ 5:1, large text ≥ 3:1, against the
  surface it actually sits on (measured, not assumed).
- **No literal colors in rules.** A hex value belongs in a token definition or nowhere.
- **Fill vs ink.** `--accent-fill` carries `--panel`-colored label; `--accent` is for text
  on neutral surfaces. They are separate tokens so dark mode cannot produce white-on-peach.

## Layout

- Three columns: sessions (272px), transcript (fluid), context (306px). Sidebars collapse
  below 900px; the transcript is the only thing that scrolls, and it scrolls alone.
- Spacing steps: 4 / 8 / 12 / 16 / 24 / 32. Sections use 1px `--line-soft` rules rather
  than cards; the only bordered surfaces are inputs, buttons, and the Run status strip.
- Message column maxes at 760px, aligned left for the agent and right for the reader.
  Bubbles size to content (no stretched full-width answers for short replies).
- No decorative icons. Where a glyph used to be, there is either a word (Sessions,
  Context, Attach, Refresh, Search) or a native control.
- Everything has a focus ring: `outline: 2px solid var(--accent)` with `outline-offset: 2px`,
  or `box-shadow` on inputs that clip.

## Motion

- Three animations, all functional: message entrance (4px rise), search panel entrance
  (2px drop), tool output reveal (fade). Durations 120–160ms.
- Nothing loops, nothing bounces, nothing animates color on its own.
- All of it sits behind `@media (prefers-reduced-motion: no-preference)`.

## States

- **Busy** is owned by `.run-status[data-state]` (`idle` / `working` / `error`) and the
  composer's Send↔Stop swap; both read from the same event stream.
- **Streaming** renders plain text (`pre-wrap`) and switches to parsed Markdown once the
  turn settles — one parse per turn, not per token.
- **Empty** shows what is true of this workspace (tools, context budget, shortcuts) and two
  real prompts; it never uses illustration or placeholder product copy.
- **Error** is a notice with a Retry action, not a modal.
- `[hidden]` is global and `!important`; nothing relies on a class to hide.

## Content

- The UI speaks in short, literal sentences. No exclamation marks, no emoji, no
  "Oops!". Status text describes what the agent is doing ("Running a tool", "bash…").
- Numbers are the real ones: context usage is the last turn's prompt tokens, tool counts
  come from the turn, workspace name comes from `/api/health`.
- No invented plan names, avatars, or account chrome.
