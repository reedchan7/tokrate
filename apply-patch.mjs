#!/usr/bin/env bun
// Surgically patches claude-hud's render/colors.ts, render/session-line.ts, and
// render/lines/project.ts in place, instead of overwriting them wholesale.
//
// Why: those three files carry a lot of fast-moving, speed-unrelated content
// (i18n, cost estimates, advisor lines, git file stats, etc.) that changes between
// claude-hud releases. A wholesale copy of an older reference file silently deletes
// whatever's new in the installed version — confirmed against a real version jump
// (0.0.11 -> 0.3.0) where it produced a SyntaxError from a missing export the rest
// of the plugin still needed. Only the exact showSpeed block and its immediate
// import line are touched here; everything else in these files is left alone.
//
// speed-tracker.ts is NOT handled here — it has no other consumers of its
// internals, so install.sh still copies tokrate's reference/speed-tracker.ts over
// it wholesale.
//
// Usage: bun apply-patch.mjs <src-dir>   (src-dir = claude-hud's .../<version>/src)
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('usage: apply-patch.mjs <src-dir>');
  process.exit(1);
}

function findMatchingBrace(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function patchColors(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('export function getSpeedColor')) {
    console.log(`[skip] ${filePath} already patched`);
    return;
  }

  for (const name of ['GREEN', 'CYAN', 'BRIGHT_MAGENTA', 'RESET']) {
    if (!new RegExp(`\\b${name}\\b`).test(content)) {
      throw new Error(`${filePath}: expected color constant "${name}" not found — claude-hud's colors.ts has drifted further than this patcher can handle safely`);
    }
  }

  const firstImportNewline = content.indexOf('\n', content.indexOf('import '));
  if (firstImportNewline === -1) {
    throw new Error(`${filePath}: could not find an import line to anchor the new type import`);
  }
  const withImport = `${content.slice(0, firstImportNewline + 1)}import type { SpeedReading } from '../speed-tracker.js';\n${content.slice(firstImportNewline + 1)}`;

  const appendix = `
/** Tiered color by current speed: fast=green, everything else=cyan. Never dim — a slow reading should still be easy to read, not look faded/broken. */
export function getSpeedColor(tokPerSec) {
  if (tokPerSec >= 150) return GREEN;
  return CYAN;
}

/** Full speed segment: current tok/s (tiered green/cyan) plus a bright-magenta peak/avg/min summary — magenta sits far enough from both speed tiers on the color wheel that the two segments never read as the same color. */
export function formatSpeedReading(reading) {
  const current = \`\${getSpeedColor(reading.speed)}⚡ \${reading.speed.toFixed(1)} tok/s\${RESET}\`;
  const { max, avg, min } = reading.stats;
  const summary = \`\${BRIGHT_MAGENTA}(▲\${max.toFixed(0)} ~\${avg.toFixed(0)} ▼\${min.toFixed(0)})\${RESET}\`;
  return \`\${current} \${summary}\`;
}
`;

  fs.writeFileSync(filePath, withImport + appendix, 'utf8');
  console.log(`[patched] ${filePath}`);
}

function patchShowSpeedBlock(filePath, colorsImportPath) {
  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('formatSpeedReading(')) {
    console.log(`[skip] ${filePath} already patched`);
    return;
  }

  const marker = 'if (display?.showSpeed) {';
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(`${filePath}: could not find "${marker}" — claude-hud's showSpeed rendering has moved or been renamed`);
  }
  const openBraceIdx = startIdx + marker.length - 1;
  const closeBraceIdx = findMatchingBrace(content, openBraceIdx);
  if (closeBraceIdx === -1) {
    throw new Error(`${filePath}: could not find the matching closing brace for the showSpeed block`);
  }
  if (!content.slice(startIdx, closeBraceIdx + 1).includes('getOutputSpeed(ctx.stdin)')) {
    throw new Error(`${filePath}: showSpeed block found, but doesn't call getOutputSpeed(ctx.stdin) as expected`);
  }

  const replacement = `if (display?.showSpeed) {
    const reading = getOutputSpeed(ctx.stdin);
    if (reading !== null) {
      parts.push(formatSpeedReading(reading));
    }
  }`;
  content = content.slice(0, startIdx) + replacement + content.slice(closeBraceIdx + 1);

  const escapedImportPath = colorsImportPath.replace(/[.]/g, '\\.');
  const colorsImportRegex = new RegExp(`import \\{([^}]*)\\} from '${escapedImportPath}';`);
  const match = content.match(colorsImportRegex);
  if (!match) {
    throw new Error(`${filePath}: could not find "import { ... } from '${colorsImportPath}'" to add formatSpeedReading to`);
  }
  if (!match[1].includes('formatSpeedReading')) {
    const newImportBody = `${match[1].trimEnd()}, formatSpeedReading `;
    content = content.replace(colorsImportRegex, `import {${newImportBody}} from '${colorsImportPath}';`);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[patched] ${filePath}`);
}

patchColors(path.join(srcDir, 'render', 'colors.ts'));
patchShowSpeedBlock(path.join(srcDir, 'render', 'session-line.ts'), './colors.js');
patchShowSpeedBlock(path.join(srcDir, 'render', 'lines', 'project.ts'), '../colors.js');
