# pi-extensions

Adds an `/extensions` command to pi that lists every discovered extension and lets you enable or disable each one on the fly.

## Commands

| Command | Description |
|---------|-------------|
| `/extensions` | Open the extension manager UI |

## How it works

The UX mirrors the built-in scoped-models / `/tools` selectors:

- A `SettingsList` with one row per extension (labeled `[global]` or `[project]`)
- Toggle each row between `enabled` and `disabled` with `←` / `→` or `Space`
- Press `Enter` to apply pending changes and reload
- Press `Esc` to cancel without changes

## How disabling works

Pi auto-discovers extensions from:

- `~/.pi/agent/extensions/` (global)
- `<cwd>/.pi/extensions/` (project-local)

To **disable** an extension, this extension renames its entry file with a `.disabled` suffix:

| Style | Disabled as |
|-------|-------------|
| Single-file | `foo.ts` → `foo.ts.disabled` |
| Directory | `bar/index.ts` → `bar/index.ts.disabled` |
| Package | the file referenced in `pi.extensions[0]` is renamed the same way |

To **re-enable**, the rename is reversed. After applying any changes the command runs `ctx.reload()` so changes take effect immediately without restarting pi.

## Notes

- The `pi-extensions` extension itself is shown in the list but cannot be disabled (it would lose the UI used to re-enable things).
- Changes are persistent — they survive restarts because they are reflected on disk.
- Extensions listed under `settings.json` `extensions[]` paths outside the standard discovery dirs are not toggled by this extension.

## Project structure

```text
pi-extensions/
├── index.ts        # Extension entry point
├── package.json    # Package metadata with pi.extensions field
├── CHANGELOG.md    # Version history
├── LICENSE         # MIT license
└── README.md       # This file
```

## Install

Drop this folder into `~/.pi/agent/extensions/`, then run pi and type `/extensions`.

## License

MIT
