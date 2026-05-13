---
name: unity-artist
description: Creates and iterates on visual art in Unity using MCP tools. Use for materials, textures, lighting, VFX, shaders, cameras, post-processing, scene dressing, and visual quality tasks.
---

# Unity Artist

Use this skill when the user wants to create, adjust, or iterate on visual content in a Unity scene via the Unity MCP server. This covers materials, textures, shaders, lighting, cameras, VFX, post-processing, and scene composition.

## First Steps

1. Connect to the Unity MCP server and confirm an active instance:
   ```
   mcp({ connect: "unity" })
   mcp({ tool: "unity_get_editor_state" })
   ```
2. Get project info to understand the render pipeline (URP, HDRP, or Built-in):
   ```
   mcp({ tool: "unity_get_project_info" })
   ```
3. Check the current scene and selection:
   ```
   mcp({ tool: "unity_get_editor_selection" })
   ```

## Core Workflow

### See → Change → Verify

Every visual change follows this loop:

1. **See** the current state — use `unity_get_cameras`, `unity_get_editor_selection`, `unity_get_rendering_stats`, or `unity_get_volumes` to understand what's there.
2. **Change** — use the appropriate tool to modify materials, lighting, VFX, textures, shaders, or scene objects.
3. **Verify** — check the result via `unity_read_console` for errors, re-query the changed object, or ask the user to confirm visually.

### Materials and Textures

- `unity_manage_material` — create, modify, assign materials; set colors, floats, textures, keywords, render queue.
- `unity_manage_texture` — generate procedural textures (noise, gradients, patterns).
- `unity_manage_shader` — create or read shader scripts.

When setting material properties, know the render pipeline's property names:
- **URP**: `_BaseColor`, `_BaseMap`, `_Metallic`, `_Smoothness`, `_BumpMap`, `_EmissionColor`
- **HDRP**: `_BaseColor`, `_BaseColorMap`, `_Metallic`, `_Smoothness`, `_NormalMap`, `_EmissiveColor`
- **Built-in**: `_Color`, `_MainTex`, `_MetallicGlossMap`, `_BumpMap`, `_EmissionColor`

### Lighting and Environment

- `unity_manage_gameobject` + `unity_manage_components` — create and configure lights.
- `unity_manage_graphics` — manage volumes, post-processing, environment settings.
- `unity_get_volumes` — list active volume overrides.
- `unity_get_renderer_features` — check URP renderer features.

### VFX and Particles

- `unity_manage_vfx` — manage ParticleSystem and VFX Graph components.

### Cameras and Composition

- `unity_manage_camera` — configure Camera and Cinemachine components.
- `unity_get_cameras` — list all scene cameras.

### Post-Processing

- Use `unity_manage_graphics` for volume-based post-processing (Bloom, Color Grading, Tonemapping, etc.).

### Scene Objects and Prefabs

- `unity_manage_gameobject` — create, move, rotate, scale objects.
- `unity_manage_prefabs` — instantiate and inspect prefabs.
- `unity_find_gameobjects` — search for objects in the scene.
- `unity_manage_probuilder` — create and edit meshes with ProBuilder.

## Tips

- Always check the render pipeline before setting shader/material properties — property names differ.
- When creating materials, specify the correct shader for the pipeline (e.g., `Universal Render Pipeline/Lit`, `HDRP/Lit`, `Standard`).
- Use `unity_manage_asset` for importing external textures and models.
- Use `unity_read_console` after changes to catch shader compilation errors or warnings.
- For complex visual setups, break work into small steps and verify each one.
- When the user describes a look or mood, translate it into concrete material properties, light settings, and post-processing values.

## Safety Rules

- Do not delete or overwrite existing materials, textures, or assets without user confirmation.
- Do not change project-wide graphics settings (quality levels, render pipeline asset) without asking.
- Preserve existing scene lighting when adding new lights unless the user explicitly wants a replacement.
- Ask before modifying prefab assets — prefer instance overrides when possible.
