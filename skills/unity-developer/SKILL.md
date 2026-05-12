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
