# pi-modes

Adds three operating modes to pi, switchable on the fly, with a custom 2-line footer and thinking-level color sync.

## Modes

| Mode | Color | Behavior |
|------|-------|----------|
| **Command** (default) | gray | Normal pi. You ask, pi executes (bash, edit, write all allowed). |
| **Plan** | cyan | pi investigates the code (read/grep/find/ls) and writes a plan into `.pi/plans/<name>.md`. **No** bash, edits, or writes outside the plan folder. |
| **Ask** | green | Pure Q&A. pi will not run bash, edit, or write anything. |

## Commands

| Command | Description |
|---------|-------------|
| `/mode` | Show current mode |
| `/mode command` | Switch to Command mode |
| `/mode plan` | Switch to Plan mode |
| `/mode ask` | Switch to Ask mode |
| `/plans` | List saved plans under `.pi/plans/` |

## Shortcuts

| Shortcut | Description |
|----------|-------------|
| `Shift+Tab` | Cycle Command → Plan → Ask → Command |

## Features

- **Mode-aware tool gating** — enforces mode restrictions at the tool-call level (LLM cannot bypass prose directives)
- **System prompt injection** — appends per-mode guidance so the LLM knows the active constraints
- **Custom 2-line footer** — top line shows mode + git branch + model + thinking level; bottom line shows cwd + token stats + context usage
- **Custom editor prompt** — input lines start with a fixed `❯` gutter prompt, and the border color matches the active mode
- **Bash command warning** — when the draft starts with `!` / `!!`, the input border and temporary `bash` mode label turn muted amber/yellow; submitted user-bash blocks use the same color for their border and `$ command` header
- **Thinking-level color sync** — thinking text color dynamically matches the active thinking level's border color
- **Session persistence** — mode survives session restarts via `pi.appendEntry()`
- **Plan management** — plans are saved as Markdown in `.pi/plans/` with a standard template (Goal, Context, Steps, Verification)

## Workflow

1. Hit `Shift+Tab` until the status bar shows **Plan** (cyan).
2. Ask pi: *"Plan how to add caching to the auth module."*
3. pi explores the code and saves `.pi/plans/auth-caching.md`.
4. Hit `Shift+Tab` back to **Command** (gray).
5. Ask pi: *"Execute the auth-caching plan."* — pi reads the file and carries out the Steps section.

Plans are plain Markdown — you can edit them by hand between steps 3 and 5.

## Project structure

```text
pi-modes/
├── index.ts        # Extension entry point
├── package.json    # Package metadata with pi.extensions field
├── CHANGELOG.md    # Version history
├── LICENSE         # MIT license
└── README.md       # This file
```

## Install

Drop this folder into `~/.pi/agent/extensions/`, then run pi.

## License

MIT
