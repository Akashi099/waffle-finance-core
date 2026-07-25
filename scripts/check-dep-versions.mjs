#!/usr/bin/env node
/**
 * scripts/check-dep-versions.mjs
 *
 * Dependency hygiene validation for the waffle-finance-core monorepo.
 * Enforces the rules documented in docs/DEPENDENCY_POLICY.md.
 *
 * Exit 0 — all checks pass (or only whitelisted skews detected)
 * Exit 1 — at least one violation found
 *
 * Usage:
 *   node scripts/check-dep-versions.mjs
 *   pnpm validate:deps
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parse a semver range string into its numeric major version.
 * Handles: "^2.21.0", "~2.21.0", "2.21.0", ">=2.0.0", "workspace:*"
 * Returns null for ranges we cannot resolve (workspace:*, *, "latest").
 */
function parseMajor(range) {
  if (!range || range === '*' || range === 'latest' || range.startsWith('workspace:')) return null;
  const m = range.match(/(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

function allDeps(pkg) {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
}

// ─── Workspace discovery ─────────────────────────────────────────────────────

function discoverPackages() {
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  if (!rootPkg) throw new Error('Root package.json not found');

  const patterns = rootPkg.workspaces ?? [];
  const results = [{ dir: ROOT, pkg: rootPkg, name: rootPkg.name ?? 'root' }];

  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(ROOT, pattern.replace('/*', ''));
      if (!fs.existsSync(parent)) continue;
      for (const sub of fs.readdirSync(parent)) {
        const dir = path.join(parent, sub);
        if (!fs.statSync(dir).isDirectory()) continue;
        const pkg = readJson(path.join(dir, 'package.json'));
        if (pkg) results.push({ dir, pkg, name: pkg.name ?? dir });
      }
    } else {
      const dir = path.join(ROOT, pattern);
      if (!fs.existsSync(dir)) continue;
      const pkg = readJson(path.join(dir, 'package.json'));
      if (pkg) results.push({ dir, pkg, name: pkg.name ?? dir });
    }
  }

  return results;
}

// ─── Policy tables (mirrors docs/DEPENDENCY_POLICY.md §2) ───────────────────

/**
 * Shared chain-client libraries: all workspace consumers must be on the
 * same major version as the canonical range below.
 *
 * Format: libName → { canonicalMajor, note }
 */
const SHARED_LIBS = {
  'viem': {
    canonicalMajor: 2,
    note: 'SDK + frontend + coordinator + resolver must all stay on viem v2',
  },
  '@stellar/stellar-sdk': {
    canonicalMajor: 13,
    note: 'Soroban XDR schema changed between v12 and v13 — do not mix majors',
  },
  '@solana/web3.js': {
    canonicalMajor: 1,
    note: 'v2 is a full rewrite; SDK + coordinator must stay on v1',
  },
  'zod': {
    canonicalMajor: 3,
    note: 'Config validation shared across packages via @wafflefinance/config',
  },
  'prom-client': {
    canonicalMajor: 15,
    note: 'Prometheus metrics; all services share the same major',
  },
};

/**
 * Libraries that must NOT appear in specific packages.
 * Format: { lib, forbiddenIn[], reason }
 */
const FORBIDDEN_IN = [
  {
    lib: 'ethers',
    forbiddenIn: ['@wafflefinance/sdk', '@wafflefinance/frontend'],
    reason: 'SDK and frontend must use viem only. ethers is relayer-only.',
  },
  {
    lib: 'wagmi',
    forbiddenIn: ['@wafflefinance/sdk', '@wafflefinance/coordinator', '@wafflefinance/relayer', '@wafflefinance/resolver'],
    reason: 'wagmi is a browser-only React hook library; server packages must not depend on it.',
  },
];

/**
 * Peer-dependency ranges that every consumer of @wafflefinance/config must satisfy.
 * These mirror the peerDependencies declared in packages/config/package.json.
 */
const CONFIG_PEER_REQUIREMENTS = {
  '@stellar/stellar-sdk': { minMajor: 13, range: '>=13.0.0' },
  'dotenv':               { minMajor: 16, range: '>=16.0.0' },
  'viem':                 { minMajor: 2,  range: '>=2.0.0'  },
};

/**
 * Intentional version skews that are ALLOWED and must not be flagged as errors.
 * Format: { lib, packageName, reason }
 *
 * These correspond to §4.2 in docs/DEPENDENCY_POLICY.md.
 */
const INTENTIONAL_SKEWS = [
  {
    lib: 'vitest',
    packageName: '@wafflefinance/frontend',
    reason:
      'frontend pins vitest ^1.x for Vite 5 + @vitejs/plugin-react ^4.2 compat. ' +
      'Upgrade vitest and vite together.',
  },
  {
    lib: '@types/node',
    packageName: '@wafflefinance/e2e',
    reason: 'e2e uses @types/node ^20 (CI image constraint). Upgrade with next Node LTS.',
  },
  {
    lib: '@types/node',
    packageName: '@wafflefinance/resolver',
    reason: 'resolver uses @types/node ^20 (same LTS constraint as e2e).',
  },
];

// ─── Check runners ───────────────────────────────────────────────────────────

function isIntentionalSkew(lib, packageName) {
  return INTENTIONAL_SKEWS.some(
    (s) => s.lib === lib && s.packageName === packageName,
  );
}

/**
 * Check 1: Shared library major-version alignment.
 * Every package that lists a shared lib must use the canonical major.
 */
function checkSharedLibAlignment(packages) {
  const errors = [];
  const warnings = [];

  for (const [lib, { canonicalMajor, note }] of Object.entries(SHARED_LIBS)) {
    for (const { name, pkg } of packages) {
      const deps = allDeps(pkg);
      const range = deps[lib];
      if (!range) continue; // package doesn't use this lib → skip

      const major = parseMajor(range);
      if (major === null) continue; // workspace:* etc. → skip

      if (major !== canonicalMajor) {
        if (isIntentionalSkew(lib, name)) {
          const skew = INTENTIONAL_SKEWS.find((s) => s.lib === lib && s.packageName === name);
          warnings.push(
            `  [SKEW ALLOWED] ${name}: ${lib}@"${range}" ` +
            `(expected major ${canonicalMajor}) — ${skew.reason}`,
          );
        } else {
          errors.push(
            `  [MAJOR MISMATCH] ${name}: ${lib}@"${range}" ` +
            `(expected major ${canonicalMajor}) — ${note}`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Check 2: Forbidden cross-surface dependencies.
 */
function checkForbiddenDeps(packages) {
  const errors = [];

  for (const { lib, forbiddenIn, reason } of FORBIDDEN_IN) {
    for (const { name, pkg } of packages) {
      if (!forbiddenIn.includes(name)) continue;
      const deps = allDeps(pkg);
      if (deps[lib]) {
        errors.push(
          `  [FORBIDDEN DEP] ${name} must not depend on "${lib}". ${reason}`,
        );
      }
    }
  }

  return { errors };
}

/**
 * Check 3: @wafflefinance/config peer-dependency satisfaction.
 * Any workspace package that depends on @wafflefinance/config must declare
 * the peer deps at or above the minimum major version.
 */
function checkConfigPeerDeps(packages) {
  const errors = [];
  const warnings = [];

  // Find all packages that consume @wafflefinance/config
  const consumers = packages.filter(({ pkg }) => {
    const deps = allDeps(pkg);
    const range = deps['@wafflefinance/config'];
    return range !== undefined;
  });

  for (const { name, pkg } of consumers) {
    const declared = allDeps(pkg);

    for (const [peer, { minMajor, range: requiredRange }] of Object.entries(CONFIG_PEER_REQUIREMENTS)) {
      const declaredRange = declared[peer];

      // If the package doesn't directly list the peer, it may be inheriting
      // it via pnpm hoisting — warn but don't hard-fail.
      if (!declaredRange) {
        warnings.push(
          `  [PEER WARNING] ${name} depends on @wafflefinance/config but does not ` +
          `explicitly declare peer "${peer}" (required: ${requiredRange}). ` +
          `Add it to dependencies or peerDependencies to prevent silent version drift.`,
        );
        continue;
      }

      const major = parseMajor(declaredRange);
      if (major !== null && major < minMajor) {
        errors.push(
          `  [PEER VIOLATION] ${name}: declares "${peer}@${declaredRange}" but ` +
          `@wafflefinance/config requires ${requiredRange}. Upgrade ${peer}.`,
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Check 4: Vitest major consistency (excluding whitelisted packages).
 * All packages that use vitest should be on the same major, except for
 * intentional skews recorded in INTENTIONAL_SKEWS.
 */
function checkVitestConsistency(packages) {
  const errors = [];
  const warnings = [];

  const usages = packages
    .map(({ name, pkg }) => {
      const range = allDeps(pkg)['vitest'];
      if (!range) return null;
      return { name, range, major: parseMajor(range) };
    })
    .filter(Boolean);

  if (usages.length < 2) return { errors, warnings };

  // Canonical = majority major among non-whitelisted packages
  const nonSkewed = usages.filter((u) => !isIntentionalSkew('vitest', u.name));
  const majorCounts = {};
  for (const { major } of nonSkewed) {
    if (major !== null) majorCounts[major] = (majorCounts[major] ?? 0) + 1;
  }
  const canonicalMajor = Object.entries(majorCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!canonicalMajor) return { errors, warnings };

  for (const { name, range, major } of usages) {
    if (major === null) continue;
    if (String(major) !== canonicalMajor) {
      if (isIntentionalSkew('vitest', name)) {
        const skew = INTENTIONAL_SKEWS.find((s) => s.lib === 'vitest' && s.packageName === name);
        warnings.push(
          `  [SKEW ALLOWED] ${name}: vitest@"${range}" vs canonical major ${canonicalMajor} — ${skew.reason}`,
        );
      } else {
        errors.push(
          `  [MAJOR MISMATCH] ${name}: vitest@"${range}" (expected major ${canonicalMajor}). ` +
          `All non-whitelisted packages should use the same vitest major.`,
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Check 5: TypeScript version consistency.
 * All packages declaring typescript must use the same major.minor to avoid
 * type-declaration compatibility issues across the workspace.
 */
function checkTypescriptConsistency(packages) {
  const errors = [];

  const usages = packages
    .map(({ name, pkg }) => {
      const range = allDeps(pkg)['typescript'];
      if (!range) return null;
      const major = parseMajor(range);
      return { name, range, major };
    })
    .filter(Boolean);

  if (usages.length < 2) return { errors };

  const majors = [...new Set(usages.map((u) => u.major).filter((m) => m !== null))];
  if (majors.length > 1) {
    for (const { name, range } of usages) {
      errors.push(
        `  [TS MISMATCH] ${name}: typescript@"${range}" — all packages must use the same TypeScript major.`,
      );
    }
  }

  return { errors };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  WaffleFinance — Dependency Hygiene Check                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Policy: docs/DEPENDENCY_POLICY.md');
  console.log('');

  let packages;
  try {
    packages = discoverPackages();
  } catch (err) {
    console.error('❌ Failed to discover workspace packages:', err.message);
    process.exit(1);
  }

  console.log(`Discovered ${packages.length} workspace package(s):`);
  for (const { name } of packages) console.log(`  • ${name}`);
  console.log('');

  const allErrors = [];
  const allWarnings = [];

  // Run all checks
  const checks = [
    { name: 'Shared library major-version alignment', fn: checkSharedLibAlignment },
    { name: 'Forbidden cross-surface dependencies',   fn: checkForbiddenDeps      },
    { name: '@wafflefinance/config peer deps',        fn: checkConfigPeerDeps     },
    { name: 'Vitest major consistency',               fn: checkVitestConsistency  },
    { name: 'TypeScript version consistency',         fn: checkTypescriptConsistency },
  ];

  for (const { name, fn } of checks) {
    console.log(`── ${name}`);
    const result = fn(packages);

    const errs   = result.errors   ?? [];
    const warns  = result.warnings ?? [];

    if (errs.length === 0 && warns.length === 0) {
      console.log('  ✅ OK');
    }
    for (const w of warns) console.log(`  ⚠️  ${w.trimStart()}`);
    for (const e of errs)  console.log(`  ❌ ${e.trimStart()}`);

    allErrors.push(...errs);
    allWarnings.push(...warns);
    console.log('');
  }

  // Summary
  console.log('══════════════════════════════════════════════════════════════');
  if (allErrors.length === 0) {
    console.log(`✅  All dependency checks passed.${allWarnings.length > 0 ? ` (${allWarnings.length} allowed skew(s) noted above)` : ''}`);
    process.exit(0);
  } else {
    console.log(`❌  ${allErrors.length} violation(s) found, ${allWarnings.length} allowed skew(s) noted.`);
    console.log('');
    console.log('Fix the violations above and re-run:  pnpm validate:deps');
    console.log('See docs/DEPENDENCY_POLICY.md for the upgrade procedure.');
    process.exit(1);
  }
}

main();
