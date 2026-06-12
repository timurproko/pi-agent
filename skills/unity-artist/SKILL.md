---
name: unity-artist
description: Creates and iterates on visual art in Unity using MCP tools. Use for materials, textures, lighting, VFX, shaders, cameras, post-processing, scene dressing, and visual quality tasks.
---

# Unity Artist

Use this skill when the user wants to create, adjust, or iterate on visual content in a Unity scene via the Unity MCP server. This covers materials, textures, shaders, lighting, cameras, VFX, post-processing, and scene composition.

## First Steps

1. Before any Unity MCP work, always make one best-effort attempt to connect the context-mode MCP server so large MCP outputs can be handled safely:
   ```
   mcp({ connect: "context-mode" })
   ```
   If it fails or direct `ctx_*` tools are already available, continue with the Unity task and mention the failure only when relevant.
2. If the user asks to connect the Unity MCP server, do it immediately:
   ```
   mcp({ connect: "unity" })
   ```
3. Prefer the direct Unity MCP tools exposed in pi when they are available. Call them directly instead of routing through the generic `mcp` gateway:
   ```
   unity_scene-list-opened({})
   unity_scene-get-data({ includeRootGameObjects: true, includeChildrenDepth: 1 })
   unity_console-get-logs({ maxEntries: 20, logTypeFilter: "Error" })
   ```
4. If only the generic MCP gateway is available, connect first and pass tool arguments as a JSON string:
   ```
   mcp({ connect: "unity" })
   mcp({ tool: "unity_scene-list-opened", args: "{}" })
   mcp({ tool: "unity_scene-get-data", args: '{"includeRootGameObjects":true,"includeChildrenDepth":1}' })
   ```
5. Determine the render pipeline from project assets/settings before choosing shaders or material property names. If MCP project-info tools are unavailable, inspect assets with `unity_assets-find` and shader lists with `unity_assets-shader-list-all`.

## Core Workflow

### Unity MCP Tool Usage

- Use direct tool calls for normal work: `unity_scene-get-data`, `unity_gameobject-find`, `unity_gameobject-create`, `unity_gameobject-component-add`, `unity_gameobject-component-modify`, `unity_assets-material-create`, `unity_assets-modify`, etc.
- Keep reads scoped. Prefer `hierarchyDepth`, `includeComponents`, `paths`, `viewQuery`, `maxResults`, and console `maxEntries` over dumping whole scenes/assets.
- Inspect before modifying: use `unity_gameobject-find`, `unity_gameobject-component-get`, `unity_assets-get-data`, or `unity_object-get-data` before patching components/assets.
- Prefer path patches or JSON patches for small targeted changes instead of broad serialized object rewrites.
- Use `unity_screenshot-isolated` only when visual verification is genuinely useful; otherwise verify through scene data, component data, bounds, and console logs.
- Use `unity_console-get-logs` after shader/material/VFX changes to catch errors and warnings.
- If a direct Unity tool is not exposed but exists on the MCP server, call it through `mcp({ tool: "...", args: "{...}" })` with valid JSON-string arguments.

### Context-Mode Command Execution

Use context-mode for any shell command, Unity/Editor log scan, shader compiler output, API response, or multi-step discovery that may produce more than a few lines. The goal is to do the noisy work in the sandbox and print only the compact answer so Unity visual sessions survive context compaction.

- Prefer `ctx_execute` / `context_mode_ctx_execute` over `bash` when command output is uncertain or large. Filter, aggregate, or summarize inside the command:
  ```js
  ctx_execute({
    language: "shell",
    code: "Unity -batchmode -quit -projectPath . -runTests -testPlatform EditMode 2>&1 | grep -E 'FAIL|Error|Exception|Shader error' | head -100",
    timeout: 900000
  })
  ```
- For large local files, never read the whole file into chat. Use `ctx_execute_file` / `context_mode_ctx_execute_file` and print only findings:
  ```js
  ctx_execute_file({
    path: "Logs/Editor.log",
    language: "javascript",
    code: "const hits = FILE_CONTENT.split('\\n').filter(l => /Shader error|Error|Exception|Warning/i.test(l)); console.log(hits.slice(-80).join('\\n') || 'No relevant log issues found');"
  })
  ```
- For 3+ related commands, use `ctx_batch_execute` / `context_mode_ctx_batch_execute` with focused `queries` instead of separate calls:
  ```js
  ctx_batch_execute({
    commands: [
      { label: "materials", command: "find Assets -name '*.mat' | head -200" },
      { label: "shaders", command: "find Assets -name '*.shader' -o -name '*.shadergraph' | head -200" },
      { label: "recent logs", command: "find Logs -name '*.log' -mtime -2 2>/dev/null" }
    ],
    queries: ["shader errors", "material assets", "recent logs"],
    concurrency: 3
  })
  ```
- For web docs such as `https://pi.dev/packages/context-mode`, use `ctx_fetch_and_index` then `ctx_search` instead of pasting page contents.
- For Unity MCP reads, first reduce output at the source with `hierarchyDepth`, `includeComponents`, `paths`, `viewQuery`, `maxResults`, and `maxEntries`. If the data still needs analysis, route command-line/log/file processing through context-mode and return only counts, paths, and actionable errors.

### See → Change → Verify

Every visual change follows this loop:

1. **See** the current state — use `unity_scene-get-data`, `unity_gameobject-find`, `unity_assets-find`, shader/material queries, or scoped screenshots to understand what's there.
2. **Change** — use the appropriate direct Unity MCP tool to modify materials, lighting, VFX, textures, shaders, or scene objects.
3. **Verify** — check the result via `unity_console-get-logs`, re-query the changed object/component/asset, or ask the user to confirm visually.

### Materials and Textures

- `unity_assets-material-create` — create material assets with a chosen shader.
- `unity_assets-modify` / `unity_object-modify` — modify material properties after inspecting asset/object data.
- `unity_assets-shader-list-all` / `unity_assets-shader-get-data` — discover shaders and shader properties.
- `unity_assets-find` — find existing materials, textures, shaders, sprites, prefabs, and scenes.

When setting material properties, know the render pipeline's property names:
- **URP**: `_BaseColor`, `_BaseMap`, `_Metallic`, `_Smoothness`, `_BumpMap`, `_EmissionColor`
- **HDRP**: `_BaseColor`, `_BaseColorMap`, `_Metallic`, `_Smoothness`, `_NormalMap`, `_EmissiveColor`
- **Built-in**: `_Color`, `_MainTex`, `_MetallicGlossMap`, `_BumpMap`, `_EmissionColor`

### Lighting and Environment

- `unity_gameobject-create` + `unity_gameobject-component-add` — create and configure light objects/components.
- `unity_gameobject-component-get` / `unity_gameobject-component-modify` — inspect and tune light, volume, reflection probe, or camera components.
- `unity_scene-get-data` — inspect current scene roots, hierarchy, bounds, and component presence.

### VFX and Particles

- `unity_gameobject-component-add` — add ParticleSystem, VisualEffect, TrailRenderer, LineRenderer, or related components.
- `unity_gameobject-component-get` / `unity_gameobject-component-modify` — inspect and adjust component fields.
- `unity_assets-find` — locate VisualEffectAssets, textures, materials, and prefabs used by effects.

### Cameras and Composition

- `unity_gameobject-find` — locate cameras and composition targets.
- `unity_gameobject-component-get` / `unity_gameobject-component-modify` — configure Camera and Cinemachine components.

### Post-Processing

- Use `unity_gameobject-find` plus component inspection/modification for volume-based post-processing objects (Bloom, Color Grading, Tonemapping, etc.).
- Use `unity_assets-find` to locate render pipeline assets, profiles, shaders, and materials before changing them.

### Scene Objects and Prefabs

- `unity_gameobject-create`, `unity_gameobject-modify`, `unity_gameobject-set-parent`, `unity_gameobject-duplicate`, `unity_gameobject-destroy` — create and arrange scene objects.
- `unity_assets-prefab-instantiate`, `unity_assets-prefab-open`, `unity_assets-prefab-save`, `unity_assets-prefab-close` — instantiate and edit prefabs safely.
- `unity_gameobject-find` — search for objects in the scene or opened prefab.

## Tips

- Always check the render pipeline before setting shader/material properties — property names differ.
- When creating materials, specify the correct shader for the pipeline (e.g., `Universal Render Pipeline/Lit`, `HDRP/Lit`, `Standard`).
- Use `unity_assets-find`, `unity_assets-get-data`, and `unity_assets-modify` for existing assets; add files externally only when needed, then call `unity_assets-refresh`.
- Use `unity_console-get-logs` after changes to catch shader compilation errors or warnings.
- For complex visual setups, break work into small steps and verify each one.
- When the user describes a look or mood, translate it into concrete material properties, light settings, and post-processing values.

## Safety Rules

- Do not delete or overwrite existing materials, textures, or assets without user confirmation.
- Do not change project-wide graphics settings (quality levels, render pipeline asset) without asking.
- Preserve existing scene lighting when adding new lights unless the user explicitly wants a replacement.
- Ask before modifying prefab assets — prefer instance overrides when possible.
