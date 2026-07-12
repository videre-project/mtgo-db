import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

function argumentError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

/**
 * Publishes staged monthly replica dumps (from replica-backfill.ts) to an
 * orphan git branch `replica-data`, committed with backdated author/committer
 * dates so the branch's history forms a chronological timeline. Consumers can
 * then clone the branch (or add it as a submodule) and filter by date via
 * `git log --since/--until`, sidestepping GitHub Releases size/backdate limits.
 *
 * Layout on the branch (months at the root, so the branch IS the replica
 * tree that the main repo mounts as a submodule at postgres/dump/replica/):
 *   <YYYY-MM>/{events,matches,decks,standings,archetypes,players,
 *               catalog_items,catalog_price_definitions,catalog_price_history}.dump.gz
 *   README.md
 *   INDEX.json
 *
 * Usage:
 *   pnpm run replica-publish [staging-dir] [--branch replica-data] [--push]
 *
 * Without --push it creates commits locally. With --push it publishes them
 * using a normal fast-forward push.
 *
 * Idempotent: unchanged months are skipped; changed mutable data is committed.
 */

const BRANCH = process.argv.includes('--branch')
  ? (process.argv[process.argv.indexOf('--branch') + 1] ?? 'replica-data')
  : 'replica-data';
const PUSH = process.argv.includes('--push');

// Skip the script path (argv[1] when run via `node script.ts`); find the first
// non-flag positional argument as the staging dir. The staging dir is expected
// to already contain <YYYY-MM>/ subdirs (postgres/dump/replica by default).
const positionalArgs: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--branch') i++;
  else if (arg === '--push' || arg === '--') continue;
  else if (!arg.startsWith('--')) positionalArgs.push(arg);
  else argumentError(`Unknown argument: ${arg}`);
}
if (!BRANCH || BRANCH.startsWith('--')) argumentError('Missing value for --branch');
if (positionalArgs.length > 1) argumentError(`Unexpected positional argument: ${positionalArgs[1]}`);
const stagingDir = positionalArgs[0] ?? 'postgres/dump/replica';
const stagingPath = path.resolve(process.cwd(), stagingDir);

function sh(cmd: string, args: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function git(args: string[], cwd?: string): string {
  const r = sh('git', args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.err}`);
  }
  return r.out.trim();
}

function commit(message: string, cwd: string, date = new Date().toISOString()): string | null {
  if (sh('git', ['diff', '--cached', '--quiet'], cwd).code === 0) return null;
  const result = spawnSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
  return git(['rev-parse', 'HEAD'], cwd);
}

interface IndexEntry {
  month: string;
  commit: string;
  profiles: string[];
  tables: { name: string; file: string; bytes: number; columns?: string[] }[];
}

async function publish(): Promise<void> {
  if (!fs.existsSync(stagingPath)) {
    throw new Error(`Staging directory not found: ${stagingPath}; run replica-backfill first`);
  }

  const repoRoot = path.resolve(process.cwd());
  const worktreePath = path.join(repoRoot, '.git', 'replica-worktree');

  // Set up the orphan branch in a worktree so the main working tree is untouched.
  if (fs.existsSync(worktreePath)) {
    sh('git', ['worktree', 'remove', '--force', worktreePath], repoRoot);
  }
  console.log(`Creating worktree for orphan branch ${BRANCH}...`);
  const branchCheck = sh('git', ['rev-parse', '--verify', `refs/heads/${BRANCH}`], repoRoot);
  if (branchCheck.code === 0) {
    git(['worktree', 'add', '--force', worktreePath, BRANCH], repoRoot);
  } else {
    // Create an orphan worktree (branch named after the dir), then rename it.
    git(['worktree', 'add', '--force', '--orphan', worktreePath], repoRoot);
    // Orphan worktree starts with the parent's files; clear them so the branch
    // is rooted only at replica/.
    for (const entry of fs.readdirSync(worktreePath)) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(worktreePath, entry), { recursive: true, force: true });
    }
    git(['branch', '-m', BRANCH], worktreePath);
  }

  // Discover already-published months from the branch root (months are
  // committed directly at the orphan branch root, e.g. 2026-01/).
  const published = new Set<string>();
  if (fs.existsSync(worktreePath)) {
    for (const entry of fs.readdirSync(worktreePath)) {
      if (entry === '.git') continue;
      if (/^\d{4}-\d{2}$/.test(entry)) published.add(entry);
    }
  }

  // Collect staging months.
  const months = fs.readdirSync(stagingPath).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();

  let committed = 0;
  let skipped = 0;

  // Staging is authoritative. Remove directories that no longer correspond
  // to a published month (for example, after correcting a release-date
  // bucket). Consumers then see the deletion on their next submodule update.
  const stagingMonths = new Set(months);
  const staleMonths = [...published].filter((month) => !stagingMonths.has(month));
  if (staleMonths.length > 0) {
    for (const month of staleMonths) fs.rmSync(path.join(worktreePath, month), { recursive: true, force: true });
    git(['add', '-A', '--', ...staleMonths], worktreePath);
    commit(`replica: remove stale months (${staleMonths.join(', ')})`, worktreePath);
    console.log(`  ✓ removed ${staleMonths.length} stale month(s)`);
  }

  for (const month of months) {
    const srcMonth = path.join(stagingPath, month);
    const dstMonth = path.join(worktreePath, month);
    fs.rmSync(dstMonth, { recursive: true, force: true });
    fs.cpSync(srcMonth, dstMonth, { recursive: true });

    // Read profiles from the per-month manifest.
    const manifestPath = path.join(srcMonth, 'REPLICA-MANIFEST.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
    const parsedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const profiles = Array.isArray(parsedManifest.profiles) ? parsedManifest.profiles as string[] : [];
    if (profiles.length === 0) throw new Error(`Missing profiles in ${manifestPath}`);

    git(['add', '-A', '--', month], worktreePath);
    const changed = sh('git', ['diff', '--cached', '--quiet', '--', month], worktreePath).code !== 0;
    if (!changed) {
      skipped++;
      continue;
    }

    // Commit this month with a backdated timestamp so git history is chronological.
    // Git rejects dates before the UNIX epoch (1970-01-01), so clamp.
    const MIN_DATE = '1970-01-01T00:00:00';
    const rawDate = `${month}-01T00:00:00`;
    const date = rawDate < MIN_DATE ? MIN_DATE : rawDate;
    const msg = `replica: ${month} (${profiles.join('+')})`;
    const isNew = !published.has(month);
    const commitDate = isNew ? date : new Date().toISOString();
    const commitId = commit(msg, worktreePath, commitDate)!;
    console.log(`  ✓ committed ${month} (${profiles.join('+')}, ${commitId.slice(0, 8)})`);
    committed++;
  }

  // Copy the branch README (self-documenting for direct clones).
  const readmeSrc = path.join(stagingPath, 'README.md');
  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, path.join(worktreePath, 'README.md'));
    git(['add', 'README.md'], worktreePath);
    commit('replica: update README.md', worktreePath);
  }

  // Rebuild INDEX.json from the authoritative manifests and current history.
  const indexPath = path.join(worktreePath, 'INDEX.json');
  const sorted: IndexEntry[] = months.map((month) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(worktreePath, month, 'REPLICA-MANIFEST.json'), 'utf8'));
    const commit = git(['log', '-1', '--format=%H', '--', month], worktreePath);
    return { month, commit, profiles: manifest.profiles, tables: manifest.tables };
  });
  fs.writeFileSync(indexPath, JSON.stringify({ branch: BRANCH, months: sorted }, null, 2));
  git(['add', 'INDEX.json'], worktreePath);
  commit('replica: update INDEX.json', worktreePath);

  console.log(`\n✓ Published ${committed} month(s), skipped ${skipped} already-present.`);
  console.log(`  branch: ${BRANCH} @ ${git(['rev-parse', 'HEAD'], worktreePath).slice(0, 8)}`);

  if (PUSH) {
    console.log('Pushing orphan branch to origin...');
    git(['push', '-u', 'origin', BRANCH], worktreePath);
    console.log('✓ Pushed.');
  } else {
    console.log('\nDry run (no push). Re-run with --push after validation.');
  }

}

publish().catch((err) => {
  console.error('\nPublish failed:', err);
  process.exitCode = 1;
}).finally(() => {
  const worktreePath = path.join(path.resolve(process.cwd()), '.git', 'replica-worktree');
  if (fs.existsSync(worktreePath)) sh('git', ['worktree', 'remove', '--force', worktreePath], process.cwd());
});
