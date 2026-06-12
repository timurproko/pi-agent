---
name: unity-developer
description: Develops, debugs, and refactors Unity C# projects. Use for Unity gameplay systems, editor tooling, ScriptableObjects, prefabs/scenes, performance, architecture, tests, CI/build issues, or Unity implementation tasks.
---

# Unity Developer

Use this skill when working on Unity projects as an implementer. Prioritize correctness in Unity's runtime model, maintainability, performance, serialization safety, and editor/runtime separation.

## First Steps

1. Identify the Unity project root by finding `Assets/`, `Packages/manifest.json`, and `ProjectSettings/ProjectVersion.txt`.
2. Read `ProjectSettings/ProjectVersion.txt` to determine the Unity version.
3. Inspect relevant assembly definitions (`*.asmdef`), package dependencies, and existing coding patterns before changing code.
4. Prefer editing source files under `Assets/` and packages under `Packages/` only when intentional.
5. Do not modify generated folders such as `Library/`, `Temp/`, `Obj/`, `Build/`, `Builds/`, or `Logs/`.

Useful discovery commands:

```bash
find . -name ProjectVersion.txt -o -name manifest.json -o -name '*.asmdef'
find Assets -name '*.cs' | head
```

## Unity MCP Tool Usage

Use Unity MCP tools when the task involves live Editor state, scenes, prefabs, components, assets, console logs, or Unity tests.

- Before any Unity MCP work, always make one best-effort attempt to connect the context-mode MCP server so large MCP outputs can be handled safely:
  ```
  mcp({ connect: "context-mode" })
  ```
  If it fails or direct `ctx_*` tools are already available, continue with the Unity task and mention the failure only when relevant.
- If the user asks to connect the Unity MCP server, do it immediately:
  ```
  mcp({ connect: "unity" })
  ```
- Prefer direct Unity MCP tools exposed in pi over the generic `mcp` gateway:
  ```
  unity_scene-list-opened({})
  unity_scene-get-data({ includeRootGameObjects: true, includeChildrenDepth: 1 })
  unity_gameobject-find({ gameObjectRef: { instanceID: 0, path: "Player" }, includeComponents: true })
  unity_console-get-logs({ maxEntries: 50, logTypeFilter: "Error" })
  ```
- If only the generic MCP gateway is available, connect first and pass arguments as a JSON string:
  ```
  mcp({ connect: "unity" })
  mcp({ tool: "unity_scene-list-opened", args: "{}" })
  mcp({ tool: "unity_gameobject-find", args: '{"gameObjectRef":{"instanceID":0,"path":"Player"},"includeComponents":true}' })
  ```
- Keep MCP reads scoped. Use `hierarchyDepth`, `includeComponents`, `includeFields`, `includeProperties`, `paths`, `viewQuery`, `maxResults`, and console `maxEntries` to avoid flooding context.
- Inspect before modifying. Use `unity_gameobject-find`, `unity_gameobject-component-get`, `unity_assets-get-data`, or `unity_object-get-data` before calling modify tools.
- Prefer targeted `pathPatches`/`jsonPatch` changes over full serialized object rewrites, especially for components, ScriptableObjects, prefabs, and materials.
- Use `unity_script-execute` for small Editor-only inspections or one-off migrations when no dedicated tool exists; do not use it to bypass source-controlled code changes.
- Use `unity_tests-run` for Unity EditMode/PlayMode tests when open scenes are saved; use `unity_console-get-logs` to inspect compiler/runtime errors after asset or script changes.
- Use prefab tools carefully: open with `unity_assets-prefab-open`, inspect/modify, save only when intended, then close with `unity_assets-prefab-close`.

### Context-Mode Command Execution

Use context-mode for any shell command, Unity test/build output, compiler log, API response, dependency scan, or multi-step discovery that may produce more than a few lines. The goal is to do the noisy work in the sandbox and print only the compact answer so Unity development sessions survive context compaction.

- Prefer `ctx_execute` / `context_mode_ctx_execute` over `bash` when command output is uncertain or large. Filter, aggregate, or summarize inside the command:
  ```js
  ctx_execute({
    language: "shell",
    code: "Unity -batchmode -quit -projectPath . -runTests -testPlatform EditMode 2>&1 | grep -E 'FAIL|Error|Exception|Tests run|Compilation failed' | head -120",
    timeout: 900000
  })
  ```
- For large local files, never read the whole file into chat. Use `ctx_execute_file` / `context_mode_ctx_execute_file` and print only findings:
  ```js
  ctx_execute_file({
    path: "Logs/Editor.log",
    language: "javascript",
    code: "const hits = FILE_CONTENT.split('\\n').filter(l => /error|exception|failed|warning/i.test(l)); console.log(hits.slice(-100).join('\\n') || 'No relevant log issues found');"
  })
  ```
- For 3+ related commands, use `ctx_batch_execute` / `context_mode_ctx_batch_execute` with focused `queries` instead of separate calls:
  ```js
  ctx_batch_execute({
    commands: [
      { label: "project version", command: "cat ProjectSettings/ProjectVersion.txt 2>/dev/null" },
      { label: "packages", command: "cat Packages/manifest.json 2>/dev/null" },
      { label: "asmdefs", command: "find Assets Packages -name '*.asmdef' 2>/dev/null" }
    ],
    queries: ["Unity version", "package dependencies", "assembly definitions"],
    concurrency: 3
  })
  ```
- For web docs such as `https://pi.dev/packages/context-mode`, use `ctx_fetch_and_index` then `ctx_search` instead of pasting page contents.
- For Unity MCP reads, first reduce output at the source with `hierarchyDepth`, `includeComponents`, `includeFields`, `includeProperties`, `paths`, `viewQuery`, `maxResults`, and console `maxEntries`. If the data still needs analysis, route command-line/log/file processing through context-mode and return only counts, paths, failing tests, and actionable compiler/runtime errors.

## Development Workflow

When implementing Unity features:

1. Clarify the target Unity version, render pipeline, platform, and whether the code is runtime, editor-only, or test code.
2. Locate existing systems and follow their architecture rather than introducing unrelated patterns.
3. Keep Unity lifecycle behavior explicit:
   - Use `Awake` for local initialization.
   - Use `OnEnable`/`OnDisable` for subscriptions and registration.
   - Use `Start` for initialization that depends on other objects being initialized.
   - Avoid expensive work in `Update`; prefer events, coroutines, jobs, timers, or cached results.
4. Make serialized data safe:
   - Use `[SerializeField] private` instead of public mutable fields where possible.
   - Preserve serialized field names or use `[FormerlySerializedAs]` when renaming serialized fields.
   - Avoid changing prefab/scene serialization unintentionally.
5. Separate editor and runtime code:
   - Put editor scripts in `Editor/` folders or editor-only assemblies.
   - Guard editor API usage with `#if UNITY_EDITOR` only when appropriate.
6. Prefer deterministic, testable logic outside `MonoBehaviour` when practical.
7. Consider play mode reload settings; avoid relying on domain reload side effects.

## C# and Unity Style

Follow existing project conventions. If no convention is obvious:

- Use clear names and small methods.
- Use `readonly` where possible for non-serialized fields.
- Cache component lookups when called repeatedly.
- Prefer `TryGetComponent` over `GetComponent` when absence is expected.
- Avoid hidden allocations in hot paths (`Update`, physics callbacks, UI layout loops).
- Avoid LINQ in hot paths unless profiling proves it is acceptable.
- Avoid `FindObjectOfType`, `GameObject.Find`, and broad scene searches in runtime paths.
- Use `CompareTag` instead of string tag comparisons.
- Use `Time.deltaTime`, `fixedDeltaTime`, or unscaled time intentionally.
- Use `UnityEngine.Pool` or project pooling for frequently spawned objects.

## Testing and Validation

Prefer running project-specific validation if available. Look for scripts, CI config, or documented commands first.

Common Unity test commands, if Unity is available on the machine:

```bash
Unity -batchmode -quit -projectPath . -runTests -testPlatform EditMode -testResults TestResults-EditMode.xml
Unity -batchmode -quit -projectPath . -runTests -testPlatform PlayMode -testResults TestResults-PlayMode.xml
```

If Unity is not available, still perform static checks by reading code, asmdefs, package versions, and compile-time symbols. State clearly which validations could not be run.

## Implementation Quality Checklist

When changing Unity code, check for:

### Correctness

- Lifecycle ordering bugs (`Awake`/`OnEnable`/`Start`, object destruction, scene loading).
- Missing unsubscriptions or event leaks.
- Coroutine lifetime and cancellation issues.
- Null reference risks from unassigned serialized fields or missing components.
- Physics code in the wrong update loop.
- Time scale mistakes (`deltaTime` vs `unscaledDeltaTime`).
- Race conditions around async/await, Addressables, asset loading, or scene transitions.

### Serialization and Asset Safety

- Renamed/removed serialized fields without migration.
- Incompatible changes to ScriptableObjects, prefabs, scenes, or custom inspectors.
- Runtime mutation of shared assets when instance data is intended.
- Use of `Resources` or Addressables without considering loading/unloading lifecycle.

### Performance

- Allocations or expensive searches in per-frame paths.
- Excessive `Instantiate`/`Destroy` churn.
- Unbatched UI/layout rebuilds or material instancing mistakes.
- Inefficient physics queries or missing layer masks.
- Unbounded logging in runtime code.

### Architecture and Maintainability

- Tight coupling between scene objects where events, interfaces, or injected references would be clearer.
- Logic that should be plain C# but is embedded in `MonoBehaviour`.
- Editor APIs leaking into player builds.
- Assembly definition dependency cycles or overly broad references.
- Platform-specific behavior not isolated or documented.

### Testing Gaps

- Missing edit mode tests for pure logic.
- Missing play mode tests for lifecycle/integration behavior.
- No migration/compatibility test for serialized data changes.
- No platform/build validation for platform-specific code.

## Output Expectations

For implementation tasks:

- Summarize what changed and why.
- Mention Unity-specific risks such as serialization migrations or prefab/scene impact.
- List tests or checks run, or explain why they were not run.

## Safety Rules

- Never edit Unity metadata files (`*.meta`) unless required and understood.
- Never delete or rewrite scenes, prefabs, or ScriptableObject assets without explicit user approval.
- Avoid broad formatting-only changes in Unity projects because they obscure serialized or generated diffs.
- Ask before upgrading Unity packages, changing render pipeline settings, or modifying project-wide settings.
