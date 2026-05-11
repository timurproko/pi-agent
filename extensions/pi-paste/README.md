# 📋 pi-paste

Smart paste extension for the **Pi coding agent**.

`pi-paste` intercepts `Ctrl+V` pastes in the terminal and automatically handles images, folder paths, file paths, and URLs — inserting compact tags into your draft and attaching or expanding them when you send the message.

## Features

- **Clipboard image paste** — images on the clipboard are read, converted to base64, and attached to your message
- **Folder path paste** — pasting a directory path like `C:\Users\me\project` inserts `[📁 project]` and expands to the full path on send
- **File path paste** — pasting a file path like `/home/me/notes.txt` inserts `[📄 notes.txt]` and expands on send
- **URL paste** — pasting a URL inserts a short `[🔗 https://example.com/...]` tag and expands on send
- **Cross-platform clipboard reading** with platform-specific backends and fallbacks
- **Zero configuration** — works out of the box with no config files or commands

## How it works

Pi-paste hooks into the terminal's [bracketed paste mode](https://en.wikipedia.org/wiki/Bracketed-paste). When you press `Ctrl+V`:

1. The extension probes the clipboard for an image
2. If an image is found, the pasted text is replaced with a tag like `[📷 image-a1b2c3.png]` and the image is queued for attachment
3. If no image is found, the pasted text is checked against the filesystem — directory paths become `[📁 name]` tags, file paths become `[📄 name]` tags
4. If the text is an HTTP/HTTPS URL, it becomes a `[🔗 ...]` tag
5. If none of the above match, the paste goes through unchanged

When you send the message:

- Image tags with successful reads are kept as visual indicators and the image data is attached
- Orphan image tags (from failed reads) are silently removed
- Folder, file, and URL tags are expanded back to their full paths/URLs in the message text

> Delete a tag from your draft before sending to cancel that attachment or expansion.

## Platform support

| Platform | Image paste | Path/URL paste |
|----------|-------------|----------------|
| Windows | ✅ | ✅ |
| Linux (X11/Wayland) | ✅ | ✅ |
| macOS | ✅* | ✅ |
| Termux / headless | ❌ | ✅ |

\* macOS clipboard image support requires the optional `@mariozechner/clipboard` native module.

### Clipboard backends

| Platform | Primary | Fallback |
|----------|---------|----------|
| Windows | `@mariozechner/clipboard` | PowerShell `System.Windows.Forms.Clipboard` |
| Linux (Wayland) | `wl-paste` | `xclip`, then `@mariozechner/clipboard` |
| Linux (X11) | `xclip` | `wl-paste`, then `@mariozechner/clipboard` |
| macOS | `@mariozechner/clipboard` | — |

## Installation

### Extension folder

Place this folder in one of these locations:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-paste` |
| Project | `.pi/extensions/pi-paste` |

Pi auto-discovers extensions in those paths.

### Via npm

```bash
pi install npm:pi-paste
```

### Via Git

```bash
pi install git:github.com/MasuRii/pi-paste
```

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_IMAGE_TOOLS_MAX_IMAGE_BYTES` | Maximum accepted image payload size | `20971520` (20 MB) |

## Project structure

```text
pi-paste/
├── index.ts               # Root entrypoint for Pi auto-discovery
├── src/
│   ├── index.ts            # Extension bootstrap, pending queues, input handler
│   ├── paste-interceptor.ts # Terminal paste interception and tag generation
│   ├── clipboard.ts        # Cross-platform clipboard image reading
│   ├── errors.ts           # Error normalization utilities
│   ├── image-mime.ts       # Image MIME type and extension mapping
│   ├── image-size.ts       # Image byte-size limits
│   ├── powershell.ts       # PowerShell command runner (Windows)
│   └── types.ts            # Shared TypeScript types
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Image tag appears but no image is attached | Confirm you copied an actual image, not text or a file path |
| Linux image paste fails | Ensure you have a graphical session and `wl-clipboard` or `xclip` installed |
| Paste goes through as plain text | Your terminal may not support bracketed paste mode |

## Development

```bash
# Type-check
npm run build
```

## License

MIT
