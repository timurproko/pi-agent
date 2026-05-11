# Changelog

## Unreleased

### Added
- Muted amber/yellow editor border warning, matching temporary `bash` mode label, and matching submitted user-bash block border/header when the current draft starts with `!` / `!!`.

## [1.0.0] - 2026-05-11

### Added
- Initial release
- Three operating modes: Command, Plan, Ask
- `Shift+Tab` shortcut to cycle modes
- `/mode` command to show or switch mode
- `/plans` command to list saved plans
- Mode-aware tool gating (blocks bash/edit/write per mode)
- System prompt injection with per-mode guidance
- Custom 2-line footer with token stats, context usage, git branch
- Custom editor border colored by active mode
- Thinking-level color sync across thinking text
- Session persistence via `pi.appendEntry()`
