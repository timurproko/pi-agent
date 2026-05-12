# pi bash config
#
# This file is loaded only for pi user-bash commands submitted with `!` / `!!`.
# Keep it non-interactive: avoid prompt setup, long-running commands, and
# commands that print output on every shell startup.

# Aliases work because the pi-bash extension enables `expand_aliases` before
# sourcing this file. Functions are safer for commands that need arguments.

alias open='cmd.exe //C start ""'