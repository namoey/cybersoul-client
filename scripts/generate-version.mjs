// Generates src/version.ts from package.json so the version string always
// reflects the single source of truth (package.json). Run on build/prepare/version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const outPath = resolve(__dirname, '..', 'src', 'version.ts');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (typeof pkg.version !== 'string' || !pkg.version) {
  throw new Error(`[generate-version] missing "version" in ${pkgPath}`);
}

const content = `// AUTO-GENERATED from package.json by scripts/generate-version.mjs — DO NOT EDIT.
// To bump the version, run \`npm version <patch|minor|major>\` or edit package.json
// and run \`npm run build\`.
export const VERSION = ${JSON.stringify(pkg.version)};
`;

writeFileSync(outPath, content, 'utf8');
console.log(`[generate-version] wrote src/version.ts -> VERSION=${pkg.version}`);
