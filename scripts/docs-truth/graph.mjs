/**
 * Deterministic docs-truth graph for THEORUM.
 * No waivers. No LLM. Ownership + evidence + freshness only.
 */

import { execFileSync } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_GRAPH_PATH = 'docs/_map.mjs';
export const EVIDENCE_FENCE = 'theorum-evidence';
const ALLOWED_EVIDENCE_KINDS = new Set([
  'source',
  'contract_test',
  'validation',
  'graph',
  'config',
  'doc',
]);

export function normalizePath(value) {
  return String(value).split(path.sep).join('/').replace(/^\.\//, '');
}

export function normalizeHeading(value) {
  return String(value).toLowerCase().replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

export function pathRuleMatches(rule, file) {
  const normalizedRule = normalizePath(rule);
  const normalizedFile = normalizePath(file);

  if (normalizedRule.includes('**')) {
    const escaped = normalizedRule
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((segment) => segment.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*');
    return new RegExp(`^${escaped}$`).test(normalizedFile);
  }

  if (normalizedRule.includes('*')) {
    const escaped = normalizedRule
      .split('*')
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${escaped}$`).test(normalizedFile);
  }

  if (normalizedRule.endsWith('/')) {
    return (
      normalizedFile === normalizedRule.slice(0, -1) || normalizedFile.startsWith(normalizedRule)
    );
  }

  return normalizedFile === normalizedRule;
}

function isIgnored(graph, file) {
  return (graph.ignore ?? []).some((rule) => pathRuleMatches(rule, file));
}

export function isProductionFile(graph, file) {
  if (isIgnored(graph, file)) return false;
  const normalized = normalizePath(file);
  if (normalized === 'mod.ts' || normalized === 'package.json') return true;
  if (normalized.startsWith('scripts/docs-truth/') && normalized.endsWith('.mjs')) return true;
  if (!normalized.endsWith('.ts')) return false;
  return (graph.production_roots ?? []).some((rule) => pathRuleMatches(rule, normalized));
}

function normalizeWatch(entry) {
  if (typeof entry === 'string') {
    return { path: normalizePath(entry), sections: [] };
  }
  return {
    ...entry,
    path: normalizePath(entry.path),
    sections: Array.isArray(entry.sections) ? entry.sections.map(String) : [],
  };
}

function normalizeSectionTrigger(entry) {
  const paths = Array.isArray(entry?.paths) ? entry.paths : entry?.path ? [entry.path] : [];
  return {
    paths: paths.map((p) => normalizePath(p)),
    sections: Array.isArray(entry?.sections) ? entry.sections.map(String) : [],
    requireAll: entry?.requireAll !== false,
  };
}

function sectionTriggerMatchesFile(trigger, file) {
  return trigger.paths.some((rule) => pathRuleMatches(rule, file));
}

function behavioralSections(entry, graph) {
  const structural = new Set(graph.structural_sections ?? ['Export', 'Ownership', 'Exported API']);
  return (entry.required_sections ?? []).filter((section) => !structural.has(section));
}

function sectionKeyTouched(changedSectionKeys, sectionName, _sections) {
  const target = normalizeHeading(sectionName);
  return changedSectionKeys.some(
    (key) => normalizeHeading(key) === target || normalizeHeading(key).endsWith(`/${target}`),
  );
}

function entryOwnsFile(entry, file) {
  const owns = (entry.owns ?? []).map(normalizePath);
  const except = (entry.owns_except ?? []).map(normalizePath);
  const matched = owns.some((rule) => pathRuleMatches(rule, file));
  if (!matched) return false;
  if (except.some((rule) => pathRuleMatches(rule, file))) return false;
  return true;
}

function entryWatchesFile(entry, file) {
  return (entry.watches ?? [])
    .map(normalizeWatch)
    .some((watch) => pathRuleMatches(watch.path, file));
}

export function entriesForFile(graph, file, { ownsOnly = false } = {}) {
  return Object.entries(graph.entries ?? {}).filter(([, entry]) => {
    if (entryOwnsFile(entry, file)) return true;
    if (ownsOnly) return false;
    return entryWatchesFile(entry, file);
  });
}

export function extractSections(source) {
  const lines = source.split('\n');
  const stack = [];
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,6})\s+(.+)$/);
    if (!match) continue;

    const level = match[1].length;
    const title = match[2].trim();
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      const closed = stack.pop();
      const closedKey = stack
        .concat(closed)
        .map((entry) => entry.title)
        .join('/');
      const existing = sections.find((section) => section.key === closedKey);
      if (existing && existing.end_line === null) {
        existing.end_line = index;
      }
    }

    stack.push({ level, title });
    const key = stack.map((entry) => entry.title).join('/');
    sections.push({
      key,
      title,
      level,
      start_line: index + 1,
      end_line: null,
      normalized: normalizeHeading(key),
    });
  }

  for (const section of sections) {
    if (section.end_line === null) section.end_line = lines.length;
  }
  return sections;
}

function findSection(sections, sectionName) {
  const target = normalizeHeading(sectionName);
  return sections.find(
    (section) => section.normalized === target || section.normalized.endsWith(`/${target}`),
  );
}

function sectionExists(sections, sectionName) {
  return Boolean(findSection(sections, sectionName));
}

function sectionBody(source, sections, sectionName) {
  const section = findSection(sections, sectionName);
  if (!section) return '';
  const lines = source.split('\n');
  return lines.slice(section.start_line, section.end_line).join('\n');
}

function sectionHasSubstance(body) {
  if (body.includes('```')) return true;
  if (/^\s*\|.+\|/m.test(body)) return true;
  if (/^\s*\d+\.\s/m.test(body)) return true;
  const bullets = body.match(/^[\s]*[-*] /gm);
  return (bullets?.length ?? 0) >= 2;
}

async function readPackageExports(repoRoot) {
  const raw = await readFile(path.resolve(repoRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  return Object.keys(pkg.exports ?? {});
}

function validateExportParity(graph, packageExports, errors) {
  const graphExports = new Set(
    Object.values(graph.entries ?? {})
      .map((entry) => entry.export)
      .filter((exp) => exp && !String(exp).startsWith('_')),
  );
  const pkgExports = new Set(packageExports);
  for (const exp of pkgExports) {
    if (!graphExports.has(exp)) {
      errors.push(`docs graph missing entry for package export ${exp}`);
    }
  }
  for (const exp of graphExports) {
    if (!pkgExports.has(exp)) {
      errors.push(`docs graph entry export ${exp} is not in package.json exports`);
    }
  }
  const internalEntries = Object.values(graph.entries ?? {}).filter((e) =>
    String(e.export ?? '').startsWith('_'),
  );
  if (internalEntries.length === 0) {
    errors.push('docs graph should include _internal/docs-truth maintainer entry');
  }
}

function minDocLinesFor(graph, docPath) {
  const map = graph.min_doc_lines ?? {};
  return map[docPath] ?? map.default ?? 0;
}

/** Evidence fence body must be JSON (zero deps). */
export function parseEvidence(source) {
  const evidence = {};
  const pattern = new RegExp(`\`\`\`${EVIDENCE_FENCE}\\n([\\s\\S]*?)\`\`\``, 'g');
  for (const match of source.matchAll(pattern)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch (error) {
      throw new Error(`invalid ${EVIDENCE_FENCE} JSON: ${error.message}`);
    }
    for (const [section, declaration] of Object.entries(parsed.sections ?? {})) {
      evidence[section] = declaration;
    }
  }
  return evidence;
}

async function pathExists(repoRoot, relativePath) {
  try {
    await access(path.resolve(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function listProductionFiles(repoRoot, graph) {
  const files = [];
  for (const root of graph.production_roots ?? []) {
    const normalized = normalizePath(root);
    const absolute = path.resolve(repoRoot, normalized.replace(/\/$/, ''));
    if (normalized.endsWith('/')) {
      for (const file of await walkFiles(absolute)) {
        const rel = normalizePath(path.relative(repoRoot, file));
        if (isProductionFile(graph, rel)) files.push(rel);
      }
    } else if (await pathExists(repoRoot, normalized)) {
      if (isProductionFile(graph, normalized)) files.push(normalized);
    }
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

export async function loadGraph(repoRoot, graphPath = DEFAULT_GRAPH_PATH) {
  const absolute = path.resolve(repoRoot, graphPath);
  const mod = await import(`${pathToFileURL(absolute).href}?t=${Date.now()}`);
  const graph = mod.default ?? mod.graph;
  if (!graph || typeof graph !== 'object') {
    throw new Error(`${graphPath}: must default-export a graph object`);
  }
  return graph;
}

function validateEvidenceSupport({ docPath, support, graphPath, graph, errors }) {
  if (!support || typeof support !== 'object') {
    errors.push(`${docPath}: evidence support must be an object`);
    return;
  }
  const kind = support.kind;
  const supportPath = support.path ? normalizePath(support.path) : null;
  if (!ALLOWED_EVIDENCE_KINDS.has(kind)) {
    errors.push(`${docPath}: unsupported evidence kind ${kind}`);
  }
  if (!supportPath) {
    errors.push(`${docPath}: evidence support missing path`);
    return;
  }
  if (
    kind === 'source' &&
    !(graph.production_roots ?? []).some((r) => pathRuleMatches(r, supportPath))
  ) {
    errors.push(`${docPath}: source evidence outside production roots: ${supportPath}`);
  }
  if (
    (kind === 'contract_test' || kind === 'validation') &&
    !(graph.validation_roots ?? []).some((r) => pathRuleMatches(r, supportPath))
  ) {
    errors.push(`${docPath}: ${kind} evidence outside validation roots: ${supportPath}`);
  }
  if (kind === 'graph' && supportPath !== normalizePath(graphPath)) {
    errors.push(`${docPath}: graph evidence must point at ${graphPath}`);
  }
  if (kind === 'doc') {
    const ok =
      supportPath === 'README.md' ||
      supportPath.startsWith('docs/') ||
      /CONTRACT\.md$/.test(supportPath) ||
      /GOOGLE\.md$/.test(supportPath) ||
      /OPENROUTER\.md$/.test(supportPath) ||
      /DOCS_TRUTH\.md$/.test(supportPath) ||
      supportPath.startsWith('docs/contracts/');
    if (!ok) {
      errors.push(`${docPath}: doc evidence path not allowed: ${supportPath}`);
    }
  }
}

function readGit(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function collectChangedLineRanges(repoRoot, base) {
  const rangesByFile = new Map();
  const merge = (diffSource) => {
    let currentFile = null;
    for (const line of diffSource.split('\n')) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4).trim();
        currentFile = target === '/dev/null' ? null : normalizePath(target.replace(/^b\//, ''));
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk || !currentFile) continue;
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) continue;
      const ranges = rangesByFile.get(currentFile) ?? [];
      ranges.push({ start, end: start + length - 1 });
      rangesByFile.set(currentFile, ranges);
    }
  };

  merge(readGit(repoRoot, ['diff', `${base}...HEAD`]));
  merge(readGit(repoRoot, ['diff']));
  merge(readGit(repoRoot, ['diff', '--cached']));
  return rangesByFile;
}

export function changedSectionsForDoc(docSource, lineRanges) {
  if (!lineRanges?.length) return new Set();
  const sections = extractSections(docSource);
  const changed = new Set();
  for (const range of lineRanges) {
    for (const section of sections) {
      if (range.start <= section.end_line && range.end >= section.start_line) {
        changed.add(section.key);
      }
    }
  }
  return changed;
}

export async function collectChangedSectionsByDoc(
  repoRoot,
  { base = process.env.THEORUM_DOCS_BASE ?? 'origin/main' } = {},
) {
  const rangesByFile = collectChangedLineRanges(repoRoot, base);
  const changedSectionsByDoc = new Map();

  for (const [file, ranges] of rangesByFile.entries()) {
    if (!file.endsWith('.md')) continue;
    try {
      const source = await readFile(path.resolve(repoRoot, file), 'utf8');
      const keys = changedSectionsForDoc(source, ranges);
      if (keys.size > 0) changedSectionsByDoc.set(file, keys);
    } catch {
      // new or deleted doc
    }
  }
  return changedSectionsByDoc;
}

export function collectChangedFiles(
  repoRoot,
  { base = process.env.THEORUM_DOCS_BASE ?? 'origin/main' } = {},
) {
  const run = (args) => readGit(repoRoot, args);

  const files = new Set();
  for (const line of run(['diff', '--name-only', `${base}...HEAD`]).split('\n')) {
    if (line.trim()) files.add(normalizePath(line.trim()));
  }
  for (const line of run(['diff', '--name-only']).split('\n')) {
    if (line.trim()) files.add(normalizePath(line.trim()));
  }
  for (const line of run(['diff', '--name-only', '--cached']).split('\n')) {
    if (line.trim()) files.add(normalizePath(line.trim()));
  }
  for (const line of run(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (line.trim()) files.add(normalizePath(line.trim()));
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

export async function lintDocsTruth({
  repoRoot,
  graphPath = DEFAULT_GRAPH_PATH,
  changedFiles = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const graph = await loadGraph(repoRoot, graphPath);

  if (graph.schema !== 'theorum.docs-truth/v1') {
    errors.push(`${graphPath}: unsupported or missing schema (want theorum.docs-truth/v1)`);
  }
  if (graph.waivers != null || graph.unmapped_waivers != null) {
    errors.push(`${graphPath}: waivers are not allowed`);
  }

  const minEvidenceSupports = graph.min_evidence_supports ?? 2;
  const packageExports = await readPackageExports(repoRoot);
  validateExportParity(graph, packageExports, errors);

  const entries = graph.entries ?? {};
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.waivers != null) {
      errors.push(`${id}: waivers are not allowed`);
    }
    if (!entry.export) {
      errors.push(`${id}: missing export field (must match package.json or _internal/*)`);
    }
    if (!Array.isArray(entry.validates) || entry.validates.length === 0) {
      errors.push(`${id}: validates must list at least one test path`);
    }
    const docPath = entry.doc ? normalizePath(entry.doc) : null;
    if (!docPath) {
      errors.push(`${id}: missing doc`);
      continue;
    }
    if (!(await pathExists(repoRoot, docPath))) {
      errors.push(`${id}: doc does not exist: ${docPath}`);
    }
    for (const watch of (entry.watches ?? []).map(normalizeWatch)) {
      if (!watch.reason) {
        errors.push(`${id}: watched path must state why it matters: ${watch.path}`);
      }
      if (!watch.sections?.length) {
        errors.push(`${id}: watched path must declare sections: ${watch.path}`);
      }
      const broad = watch.path.endsWith('/') || watch.path.includes('*');
      if (!broad && !(await pathExists(repoRoot, watch.path))) {
        errors.push(`${id}: watched path does not exist: ${watch.path}`);
      }
    }
    for (const validationPath of (entry.validates ?? []).map(normalizePath)) {
      if (!(await pathExists(repoRoot, validationPath))) {
        errors.push(`${id}: validation path does not exist: ${validationPath}`);
      }
    }
  }

  const productionFiles = await listProductionFiles(repoRoot, graph);
  for (const file of productionFiles) {
    const owners = entriesForFile(graph, file, { ownsOnly: true });
    if (owners.length === 0) {
      errors.push(`${file}: production file has no owning docs-truth entry`);
    } else if (owners.length > 1) {
      errors.push(`${file}: owned by multiple entries (${owners.map(([id]) => id).join(', ')})`);
    }
  }

  for (const [_id, entry] of Object.entries(entries)) {
    const docPath = normalizePath(entry.doc);
    if (!(await pathExists(repoRoot, docPath))) continue;

    let docSource;
    let evidence;
    try {
      docSource = await readFile(path.resolve(repoRoot, docPath), 'utf8');
      evidence = parseEvidence(docSource);
    } catch (error) {
      errors.push(`${docPath}: ${error.message}`);
      continue;
    }

    const sections = extractSections(docSource);
    const minLines = minDocLinesFor(graph, docPath);
    const lineCount = docSource
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('```')).length;
    if (minLines > 0 && lineCount < minLines) {
      errors.push(`${docPath}: ${lineCount} substantive lines; need at least ${minLines}`);
    }

    const structural = new Set(
      graph.structural_sections ?? ['Export', 'Ownership', 'Exported API'],
    );

    for (const required of entry.required_sections ?? []) {
      if (!sectionExists(sections, required)) {
        errors.push(`${docPath}: missing required section ${required}`);
      }
      if (!evidence[required]) {
        errors.push(`${docPath}: missing evidence for section ${required}`);
      }
      const body = sectionBody(docSource, sections, required);
      if (body && !sectionHasSubstance(body)) {
        errors.push(`${docPath}: section ${required} must include a table or code fence`);
      }
      if (!structural.has(required)) {
        const supports = evidence[required]?.supports ?? [];
        const hasTest = supports.some(
          (s) => s?.kind === 'contract_test' || s?.kind === 'validation',
        );
        if (!hasTest) {
          errors.push(
            `${docPath}: behavioral section ${required} must include contract_test evidence`,
          );
        }
      }
    }

    for (const [sectionName, declaration] of Object.entries(evidence)) {
      if (!sectionExists(sections, sectionName)) {
        errors.push(`${docPath}: evidence references missing section ${sectionName}`);
      }
      const supports = declaration?.supports ?? [];
      if (!Array.isArray(supports) || supports.length < minEvidenceSupports) {
        errors.push(
          `${docPath}: evidence for ${sectionName} must have at least ${minEvidenceSupports} supports`,
        );
        continue;
      }
      for (const support of supports) {
        validateEvidenceSupport({ docPath, support, graphPath, graph, errors });
        if (support?.path && !(await pathExists(repoRoot, normalizePath(support.path)))) {
          errors.push(`${docPath}: evidence path does not exist: ${normalizePath(support.path)}`);
        }
      }
    }
  }

  const mappedDocs = new Set(
    Object.values(entries)
      .map((entry) => normalizePath(entry.doc))
      .filter(Boolean),
  );
  const normalizedChanged = [
    ...new Set((changedFiles ?? collectChangedFiles(repoRoot)).map(normalizePath)),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const touchedDocs = new Set(normalizedChanged.filter((file) => mappedDocs.has(file)));
  const changedSectionsByDoc = await collectChangedSectionsByDoc(repoRoot);

  for (const changedFile of normalizedChanged) {
    if (!isProductionFile(graph, changedFile)) continue;
    // Deletions show up in git diffs; ownership applies to the live tree only.
    if (!(await pathExists(repoRoot, changedFile))) continue;

    const matching = entriesForFile(graph, changedFile);
    if (matching.length === 0) {
      errors.push(`${changedFile}: production file changed but no entry owns or watches it`);
      continue;
    }

    for (const [entryId, entry] of matching) {
      const docPath = normalizePath(entry.doc);
      if (!touchedDocs.has(docPath)) {
        errors.push(`${changedFile}: changed without touching owning doc ${docPath}`);
        continue;
      }

      let docSource = '';
      try {
        docSource = await readFile(path.resolve(repoRoot, docPath), 'utf8');
      } catch {
        errors.push(`${docPath}: cannot read doc for section freshness`);
        continue;
      }
      const docSections = extractSections(docSource);
      let changedKeys = [...(changedSectionsByDoc.get(docPath) ?? [])];
      if (touchedDocs.has(docPath) && changedKeys.length === 0) {
        changedKeys = docSections.map((section) => section.key);
      }

      const explicitTriggers = (entry.section_triggers ?? [])
        .map(normalizeSectionTrigger)
        .filter((trigger) => sectionTriggerMatchesFile(trigger, changedFile));

      if (explicitTriggers.length > 0) {
        for (const trigger of explicitTriggers) {
          const missing = trigger.sections.filter(
            (section) => !sectionKeyTouched(changedKeys, section, docSections),
          );
          if (missing.length > 0) {
            errors.push(
              `${changedFile}: changed without touching doc sections ${docPath}#${missing.join(', ')} (trigger ${entryId})`,
            );
          }
        }
        continue;
      }

      const watch = (entry.watches ?? [])
        .map(normalizeWatch)
        .find((w) => pathRuleMatches(w.path, changedFile));
      if (watch?.sections?.length) {
        const missing = watch.sections.filter(
          (section) => !sectionKeyTouched(changedKeys, section, docSections),
        );
        if (missing.length > 0) {
          errors.push(
            `${changedFile}: changed without touching watched sections ${docPath}#${missing.join(', ')}`,
          );
        }
        continue;
      }

      if (entryOwnsFile(entry, changedFile)) {
        const behavioral = behavioralSections(entry, graph);
        const touchedBehavioral = behavioral.filter((section) =>
          sectionKeyTouched(changedKeys, section, docSections),
        );
        if (behavioral.length > 0 && touchedBehavioral.length === 0) {
          errors.push(
            `${changedFile}: doc ${docPath} touched but no behavioral section updated (need one of: ${behavioral.join(', ')})`,
          );
        }
      }
    }
  }

  return { graph, errors, warnings, productionFiles, changedFiles: normalizedChanged };
}

export async function buildInventory(repoRoot, graphPath = DEFAULT_GRAPH_PATH) {
  const graph = await loadGraph(repoRoot, graphPath);
  const productionFiles = await listProductionFiles(repoRoot, graph);
  const owned = productionFiles.map((file) => {
    const owners = entriesForFile(graph, file, { ownsOnly: true }).map(([id]) => id);
    return { file, owners };
  });
  return {
    schema: graph.schema,
    entry_count: Object.keys(graph.entries ?? {}).length,
    production_file_count: productionFiles.length,
    unowned: owned.filter((row) => row.owners.length === 0).map((row) => row.file),
    multi_owned: owned.filter((row) => row.owners.length > 1),
    owned,
  };
}
