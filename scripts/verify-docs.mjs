import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const excludedDirectories = new Set([
  '.git',
  '.npm-cache',
  '.tools',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
]);
const textExtensions = new Set([
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.prisma',
  '.sh',
  '.sql',
  '.ts',
  '.yaml',
  '.yml',
]);
const extensionlessTextFiles = new Set([
  '.dockerignore',
  '.env',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  'Dockerfile',
]);

export function assertSafeText(text, source) {
  const credential =
    /mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}/i;
  if (credential.test(text)) {
    throw new Error(`Realistic API credential found in ${source}.`);
  }
  const bearer =
    /Authorization\s*:\s*Bearer\s+(?![<$%{[])[A-Za-z0-9._~-]{32,}/i;
  if (bearer.test(text)) {
    throw new Error(`Realistic bearer token found in ${source}.`);
  }
  const hostedDatabase =
    /postgres(?:ql)?:\/\/[^\s:@/]+:(?!postgres(?:@|%40)|password(?:@|%40)|<[^>]+>@|\$\{)[^\s@/]{12,}@/i;
  if (hostedDatabase.test(text)) {
    throw new Error(`Realistic database credential found in ${source}.`);
  }
  const providerToken =
    /\b(?:gh[oprsu]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/;
  if (providerToken.test(text)) {
    throw new Error(`Provider token found in ${source}.`);
  }
  const assignment =
    /\b(?:SYSTEM_ADMIN_TOKEN|METRICS_TOKEN|API_KEY_PEPPER|POSTGRES_PASSWORD)\s*[=:]\s*(?!["']?(?:<[^>]+>|\$\{|CHANGE_ME))["']?([\x21-\x7e]{43,})["']?/i;
  if (assignment.test(text)) {
    throw new Error(`Realistic secret assignment found in ${source}.`);
  }
}

async function walk(root, directory = root) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (entry.isFile() && entry.name === '.env') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(root, path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

async function repositoryPaths(root) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '--cached', '-z'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .filter(
        (path) =>
          !path
            .split(/[\\/]/)
            .some((segment) => excludedDirectories.has(segment)),
      )
      .map((path) => resolve(root, path));
  } catch {
    return walk(root);
  }
}

async function localSecretValues(root) {
  try {
    const contents = await readFile(join(root, '.env'), 'utf8');
    return contents
      .split(/\r?\n/)
      .map((line) => {
        const value = line.match(
          /^\s*(?:SYSTEM_ADMIN_TOKEN|METRICS_TOKEN|API_KEY_PEPPER|POSTGRES_PASSWORD|DATABASE_URL)\s*=\s*(.+?)\s*$/,
        )?.[1];
        if (!value) return undefined;
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          return value.slice(1, -1);
        }
        return value;
      })
      .filter(
        (value) =>
          value && !value.startsWith('CHANGE_ME') && !value.startsWith('<'),
      );
  } catch {
    return [];
  }
}

async function verifyLinks(markdownPath, text) {
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (
      target.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.startsWith('//')
    ) {
      continue;
    }
    const decoded = decodeURIComponent(target.split('#', 1)[0]);
    const linkedPath = isAbsolute(decoded)
      ? decoded
      : resolve(dirname(markdownPath), decoded);
    try {
      await stat(linkedPath);
    } catch {
      throw new Error(
        `Missing documentation link target ${target} from ${markdownPath}.`,
      );
    }
  }
}

export async function verifyDocumentation(root = process.cwd()) {
  const paths = await repositoryPaths(root);
  const privateValues = await localSecretValues(root);
  let markdownCount = 0;
  for (const path of paths) {
    const extension = extname(path).toLowerCase();
    const fileName = path.split(/[\\/]/).at(-1);
    if (
      !textExtensions.has(extension) &&
      !extensionlessTextFiles.has(fileName)
    ) {
      continue;
    }
    const text = await readFile(path, 'utf8');
    assertSafeText(text, path);
    if (privateValues.some((value) => text.includes(value))) {
      throw new Error(
        `A local secret value was copied into tracked file ${path}.`,
      );
    }
    if (extension === '.md') {
      markdownCount += 1;
      await verifyLinks(path, text);
    }
  }
  return { markdownCount, scannedFileCount: paths.length };
}

async function main() {
  const result = await verifyDocumentation();
  process.stdout.write(
    `Documentation verified: ${result.markdownCount} Markdown files, ${result.scannedFileCount} repository files scanned.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
