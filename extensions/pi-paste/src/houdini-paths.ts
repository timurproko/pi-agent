/**
 * Houdini Path Chips — collapse pasted Houdini node paths into compact chips.
 *
 * When you paste a path like `/obj/house_builder/source/planter_full_geo`,
 * the editor shows `[🟧 planter_full_geo]`. When you send the message,
 * the full path is expanded back so the LLM (and MCP tools) see the real path.
 *
 * Recognised Houdini root contexts:
 *   /obj  /stage  /out  /mat  /ch  /img  /shop  /tasks  /cop2
 */

const HOUDINI_ROOTS = [
  "obj",   // Object networks (SOPs, geometry)
  "stage", // LOPs / Solaris / USD
  "out",   // ROPs / Render outputs
  "mat",   // Materials
  "ch",    // CHOPs / Channels
  "img",   // COPs / Compositing
  "shop",  // Shaders (legacy)
  "tasks", // TOPs / PDG
  "cop2",  // Legacy COPs
];

// Matches /root/seg1, /root/seg1/seg2, etc.  Segments allow word chars + hyphen.
const HOUDINI_PATH_RE = new RegExp(
  `\\/(${HOUDINI_ROOTS.join("|")})(\\/[\\w-]+)+`,
  "g",
);

/** Tag pattern used to detect Houdini chips in submitted text. */
export const HOUDINI_CHIP_RE = /\[🟧 [^\]]+\]/gu;

/**
 * Test whether text contains at least one Houdini node path.
 */
export function containsHoudiniPath(text: string): boolean {
  HOUDINI_PATH_RE.lastIndex = 0;
  return HOUDINI_PATH_RE.test(text);
}

/**
 * Replace every Houdini node path in `content` with a compact chip.
 * Records chip→fullPath mappings in the provided `pathMap`.
 * Returns the transformed string, or `undefined` if nothing changed.
 */
export function replaceHoudiniPaths(
  content: string,
  pathMap: Map<string, string>,
): string | undefined {
  HOUDINI_PATH_RE.lastIndex = 0;
  if (!HOUDINI_PATH_RE.test(content)) return undefined;

  HOUDINI_PATH_RE.lastIndex = 0;
  const transformed = content.replace(HOUDINI_PATH_RE, (match) => {
    const segments = match.split("/").filter(Boolean);
    const nodeName = segments[segments.length - 1]!;
    let chip = `[🟧 ${nodeName}]`;

    // Disambiguate when the same leaf name maps to a different path
    if (pathMap.has(chip) && pathMap.get(chip) !== match) {
      const parent = segments[segments.length - 2] ?? segments[0];
      chip = `[🟧 ${parent}/${nodeName}]`;
    }

    pathMap.set(chip, match);
    return chip;
  });

  return transformed === content ? undefined : transformed;
}

/**
 * Expand all Houdini chips in `text` back to full paths using the map.
 * Returns the expanded text and whether any expansion occurred.
 */
export function expandHoudiniChips(
  text: string,
  pathMap: Map<string, string>,
): { text: string; changed: boolean } {
  let changed = false;
  let result = text;

  for (const [chip, fullPath] of pathMap) {
    if (result.includes(chip)) {
      result = result.replaceAll(chip, fullPath);
      changed = true;
    }
  }

  return { text: result, changed };
}
