/**
 * Extract Android package/application ID from build config files.
 * Pure functions — no I/O, no Pi API.
 */

/**
 * Extract `package="..."` from AndroidManifest.xml.
 */
export function extractPackageFromManifest(xml: string): string | null {
  const pkgMatch = xml.match(/package="([^"]+)"/);
  return pkgMatch?.[1] ?? null;
}

/**
 * Extract `applicationId = "..."` or `namespace = "..."` from build.gradle.kts (Kotlin DSL).
 */
export function extractPackageFromGradleKts(content: string): string | null {
  const appIdMatch = content.match(/applicationId\s*=\s*["']([^"']+)["']/);
  const namespaceMatch = content.match(/namespace\s*=\s*["']([^"']+)["']/);
  return appIdMatch?.[1] || namespaceMatch?.[1] || null;
}

/**
 * Extract `applicationId "..."` or `namespace "..."` from build.gradle (Groovy DSL).
 */
export function extractPackageFromGradle(content: string): string | null {
  const appIdMatch = content.match(/applicationId\s+["']([^"']+)["']/);
  const appIdUnquoted = appIdMatch?.[1] ?? null;
  if (appIdUnquoted) return appIdUnquoted;
  const nsMatch = content.match(/namespace\s+["']([^"']+)["']/);
  if (nsMatch?.[1]) return nsMatch[1];
  // Fallback: unquoted (must match dotted identifier only)
  const appIdPlain = content.match(/applicationId\s+([a-zA-Z][a-zA-Z0-9_.]*)/);
  if (appIdPlain?.[1]) return appIdPlain[1];
  const nsPlain = content.match(/namespace\s+([a-zA-Z][a-zA-Z0-9_.]*)/);
  return nsPlain?.[1] ?? null;
}
