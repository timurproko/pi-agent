# Asset Store Pi Extension

Pi extension replacement for the Python app at `E:\Git\asset-store-downloader`.

## Usage

1. Put a `config.json` in this extension folder (`~/.pi/agent/extensions/asset-store`). The extension uses the same shape as the Python app:

```json
{
  "accounts": [
    { "name": "Personal", "download_dir": "./downloads/personal", "cookie": "" }
  ],
  "active_account": "Personal",
  "max_workers": 3,
  "retry": 3,
  "timeout": 300
}
```

Legacy top-level `cookie` configs are normalized to a single account.

2. Install extension dependencies once:

```bash
cd ~/.pi/agent/extensions/asset-store
npm install
```

3. `/reload`, then run:

```text
/asset-store
```

## UI

The command opens a Pi editor/TUI asset browser:

- Type to search assets by id or name.
- If multiple accounts are configured, press Tab to switch the account filter.
- Press Enter on an asset to open actions: download, extract, open folders, refresh, or account settings.
- Press Ctrl+R to refresh the selected account's asset list.

Account settings are also available from `/extensions`: select `asset-store` and press Space on its `[settings]` entry.
Long operations display progress in the editor UI and an `asset-store-progress` widget.

## Data/output layout

The extension stores its config and library cache under the extension folder. Downloads and extracted packages use the Windows Downloads folder by default:

| Path | Role |
| --- | --- |
| `config.json` | Accounts, active account, retry/timeout settings, and cookies |
| `data/asset_list.<account>.jsonl` | Paginated `searchMyAssets` responses |
| `data/asset_info.<account>.jsonl` | Product detail JSONL used for search/download filenames |
| `data/asset_ids.<account>.txt` | Product IDs fetched for the account |
| `C:\\Users\\tprokopiev\\Downloads` by default | `.unitypackage` downloads |
| `C:\\Users\\tprokopiev\\Downloads/.cache` by default | Resume metadata |
| `C:\\Users\\tprokopiev\\Downloads/<package-stem>/` by default | Extracted files |

Relative custom `download_dir` values in `config.json` are resolved from the extension folder. Absolute `download_dir` values are still respected.

## Privacy

Cookies are secrets. The extension stores them only in `config.json` and does not include cookie values in tool output, Pi session details, or notifications.

## Automation tools

The extension also registers LLM-callable tools:

- `asset_store_search`
- `asset_store_download`
- `asset_store_extract`

Use `/asset-store` for the full interactive workflow.
