---
name: houdini-artist
description: Creates and iterates on 3D art, procedural geometry, simulations, materials, lighting, and rendering in Houdini via MCP tools. Use for modeling, look-dev, FX, layout, USD, and rendering tasks.
---

# Houdini Artist

Use this skill when the user wants to create, adjust, or iterate on 3D content in Houdini via the Houdini MCP server. This covers procedural modeling, simulations, materials, lighting, rendering, USD/LOPs, and scene composition.

## First Steps

1. Connect to the Houdini MCP server:
   ```
   mcp({ connect: "houdini" })
   ```
2. Get scene context:
   ```
   mcp({ tool: "houdini_get_scene_info" })
   mcp({ tool: "houdini_get_scene_summary" })
   ```
3. Understand the current network:
   ```
   mcp({ tool: "houdini_list_children", args: '{"node_path": "/obj"}' })
   ```

## Core Workflow

### See → Build → Verify

1. **See** — use `houdini_get_scene_summary`, `houdini_get_network_overview`, `houdini_get_geometry_info`, `houdini_render_viewport`, or `houdini_get_node_info` to understand the current state.
2. **Build** — create nodes, set parameters, wire connections, write VEX/Python.
3. **Verify** — use `houdini_render_viewport` to see results, `houdini_find_error_nodes` to check for errors, `houdini_get_geometry_info` to confirm geometry, or `houdini_explain_node` to understand what a node does.

### Procedural Modeling (SOPs)

- `houdini_create_node` — create SOP nodes inside geometry objects.
- `houdini_build_sop_chain` — build a sequential chain of SOPs wired together (efficient for multi-node setups).
- `houdini_connect_nodes` / `houdini_connect_nodes_batch` — wire nodes together.
- `houdini_set_parameter` / `houdini_set_parameters` — configure node parameters.
- `houdini_create_wrangle` — create Attribute Wrangle nodes with VEX code for custom geometry manipulation.
- `houdini_get_geometry_info` — inspect point/prim counts, attributes, bounds.
- `houdini_get_points` / `houdini_get_prims` — read geometry data.
- `houdini_get_bounding_box` — check spatial extent.
- `houdini_sample_geometry` — sample points for inspection.

### Simulations (DOPs)

- `houdini_setup_pyro_sim` — build Pyro smoke/fire simulations.
- `houdini_setup_rbd_sim` — build RBD rigid-body simulations.
- `houdini_setup_flip_sim` — build FLIP fluid simulations.
- `houdini_setup_vellum_sim` — build Vellum cloth/soft-body simulations.
- `houdini_get_simulation_info` / `houdini_list_dop_objects` — inspect simulation state.
- `houdini_step_simulation` / `houdini_reset_simulation` — control simulation playback.

### Materials and Look-Dev

- `houdini_create_material` — create materials with configurable properties.
- `houdini_assign_material` — assign materials to geometry.
- `houdini_list_materials` / `houdini_get_material_info` — inspect existing materials.
- `houdini_create_material_network` — create material networks.
- `houdini_list_material_types` — discover available material/VOP types.

### Lighting

- `houdini_create_light` — create USD lights in LOP networks.
- `houdini_list_lights` — list all lights.
- `houdini_set_light_properties` — adjust light parameters.
- `houdini_create_light_rig` — create preset lighting rigs (studio, outdoor, etc.).

### Rendering

- `houdini_render_viewport` — capture viewport to see current state (essential for visual iteration).
- `houdini_render_quad_view` — capture all four viewport panes.
- `houdini_setup_render` — set up camera and ROP for final renders.
- `houdini_create_render_node` / `houdini_start_render` — create and trigger renders.
- `houdini_get_render_settings` / `houdini_set_render_settings` — configure render parameters.
- `houdini_set_viewport_display` — change viewport shading mode.
- `houdini_set_viewport_renderer` — set Hydra rendering delegate (Karma, Storm, etc.).

### USD / LOPs

- `houdini_create_lop_node` — create LOP nodes.
- `houdini_get_stage_info` — get USD stage overview.
- `houdini_list_usd_prims` / `houdini_get_usd_prim` — browse USD hierarchy.
- `houdini_get_usd_attribute` / `houdini_set_usd_attribute` — read/write USD attributes.
- `houdini_get_usd_materials` — list USD materials.
- `houdini_get_usd_variants` — inspect variant sets.

### VEX and Expressions

- `houdini_create_wrangle` — create wrangles with VEX code.
- `houdini_set_wrangle_code` / `houdini_get_wrangle_code` — edit VEX on existing wrangles.
- `houdini_set_expression` / `houdini_get_expression` — set HScript/Python expressions on parameters.
- `houdini_validate_vex` — validate VEX by cooking and checking errors.

### Animation and Timeline

- `houdini_set_keyframe` / `houdini_set_keyframes` — set keyframes.
- `houdini_get_keyframes` — read existing keyframes.
- `houdini_set_frame` / `houdini_get_frame` — navigate timeline.
- `houdini_set_frame_range` / `houdini_set_playback_range` — configure frame ranges.

### HDAs (Digital Assets)

- `houdini_list_installed_hdas` / `houdini_get_hda_info` — inspect installed HDAs.
- `houdini_create_hda` — create an HDA from a subnet.
- `houdini_install_hda` / `houdini_uninstall_hda` — manage HDA installations.

### Caching

- `houdini_list_caches` / `houdini_get_cache_status` — inspect caches.
- `houdini_write_cache` — write cache to disk.
- `houdini_clear_cache` — clear cached files.

## Tips

- Use `houdini_render_viewport` frequently to see visual results — it's the primary way to verify art changes.
- Use `houdini_build_sop_chain` instead of individual `create_node` + `connect_nodes` calls when building linear chains.
- Use `houdini_set_parameters` (batch) instead of multiple `houdini_set_parameter` calls.
- Use `houdini_find_error_nodes` after building networks to catch problems.
- Use `houdini_explain_node` to understand unfamiliar nodes.
- Use `houdini_layout_children` after building networks to keep things tidy.
- For complex setups, build incrementally: create a few nodes, verify geometry, then continue.
- When writing VEX, use `houdini_validate_vex` to catch syntax errors.

## Safety Rules

- Do not delete nodes or clear caches without user confirmation.
- Do not overwrite the scene file without asking.
- Do not modify HDAs without user approval — prefer creating new HDAs or working on instances.
- Preserve existing networks; add new nodes alongside existing work unless told to replace.
- Ask before changing global scene settings (FPS, frame range, render settings).
