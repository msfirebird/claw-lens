/**
 * Shared model metadata: context window limits, pricing, and utility functions.
 * Single source of truth — all API routes import from here.
 *
 * Context window data is enriched at startup from the locally installed
 * OpenClaw package (dist/model-definitions-*.js), so values stay in sync
 * with the upstream provider catalogs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { globSync } from 'glob';

/* ── Context Window Limits ───────────────────────────────────────────── */

export const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  // Claude 4.x (1M context)
  'claude-opus-4':          1000000,
  'claude-sonnet-4':        1000000,
  'claude-haiku-4':         1000000,
  // Claude 3.x (200K context)
  'claude-3-5-sonnet':      200000,
  'claude-3-5-haiku':       200000,
  'claude-3-opus':          200000,
  'claude-3-haiku':         200000,
  // Qwen
  'qwen3.6-plus':          1000000,
  // GPT 5.x
  'gpt-5.2':               1000000,
  'gpt-5.2-codex':          272000,
  'gpt-5.1-codex-mini':     128000,
  'gpt-5.1-codex':          128000,
  'gpt-5':                  128000,
  // GPT 4.x
  'gpt-4o':                 128000,
  'gpt-4o-mini':            128000,
  'gpt-4-turbo':            128000,
  'gpt-4':                    8192,
  // Gemini
  'gemini-1.5-pro':        1000000,
  'gemini-1.5-flash':      1000000,
  'gemini-2.0-flash':      1000000,
  // Reasoning models
  'o1':                     200000,
  'o3':                     200000,
  'o4-mini':                200000,
  // Codex standalone
  'codex':                  128000,
};

/**
 * Resolve the context window limit for a model string.
 * Matching priority: exact → prefix → OpenRouter provider strip → substring → fallback.
 */
export function getContextLimit(model: string | null): number {
  if (!model) return 200000;

  // Exact match
  if (MODEL_CONTEXT_WINDOW[model]) return MODEL_CONTEXT_WINDOW[model];

  // Prefix match (e.g. "claude-sonnet-4-6-20260401" → "claude-sonnet-4")
  // Sort by key length descending so longer (more specific) prefixes match first
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_WINDOW).sort((a, b) => b[0].length - a[0].length)) {
    if (model.startsWith(key)) return limit;
  }

  // OpenRouter-style "provider/model" — strip provider prefix and recurse
  if (model.includes('/')) {
    const sub = model.split('/').slice(1).join('/');
    if (sub && sub !== model) {
      const fromSub = getContextLimit(sub);
      if (fromSub) return fromSub;
    }
  }

  // Substring fallback
  const m = model.toLowerCase();
  if (m.includes('claude'))  return 200000;
  if (m.includes('gemini'))  return 1000000;
  if (m.includes('gpt'))     return 128000;
  if (m.includes('codex'))   return 128000;
  if (m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 200000;
  if (m.includes('qwen'))    return 1000000;

  return 200000;
}

/* ── Load context windows from OpenClaw ──────────────────────────────── */

/**
 * Find the openclaw install directory by resolving the `openclaw` binary.
 */
function findOpenClawDir(): string | null {
  // 1. Try require.resolve (works if openclaw is in node_modules)
  try {
    const pkgPath = require.resolve('openclaw/package.json');
    return path.dirname(pkgPath);
  } catch { /* not in local node_modules */ }

  // 2. Resolve via `which openclaw` binary → lib/node_modules/openclaw/
  try {
    const bin = execSync('which openclaw', { encoding: 'utf8', timeout: 3000 }).trim();
    if (bin) {
      const real = fs.realpathSync(bin);
      // e.g. .../lib/node_modules/openclaw/dist/cli.js → .../lib/node_modules/openclaw
      // or   .../lib/node_modules/openclaw/openclaw.mjs → .../lib/node_modules/openclaw
      const dir = path.dirname(real);
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      // bin might be a symlink directly into the package root
      const parent = path.dirname(dir);
      if (fs.existsSync(path.join(parent, 'package.json'))) return parent;
    }
  } catch { /* which not available or openclaw not installed */ }

  return null;
}

/**
 * Parse dist JS files from the OpenClaw dist directory.
 * Extracts model id → contextWindow mappings.
 *
 * Handles three formats found in OpenClaw bundles:
 *   Format A: "model-id": { ..., contextWindow: VALUE, ... }   (catalog objects)
 *   Format B: { id: "model-id", ..., contextWindow: VALUE, ... } (array-of-objects)
 *   Format C: const PREFIX_MODEL_ID = "id" + const PREFIX_CONTEXT_TOKENS = N
 *             (constant-pair pattern used by openai-codex-provider etc.)
 * VALUE may be a numeric literal (202800, 2e5) or an ALL_CAPS constant reference.
 */
function parseModelDefinitions(distDir: string): Record<string, number> {
  const results: Record<string, number> = {};

  // Scan model-definitions-*.js plus provider/catalog/models files that contain model specs
  const fileSet = new Set<string>([
    ...globSync('model-definitions-*.js', { cwd: distDir }),
    ...globSync('models-*.js',            { cwd: distDir }),
    ...globSync('*provider*.js',          { cwd: distDir }),
    ...globSync('*catalog*.js',           { cwd: distDir }),
  ]);

  const numVal = /\d+(?:\.\d+)?(?:[eE]\d+)?/;
  const constName = /[A-Z_][A-Z0-9_]*/;
  const valPat = new RegExp(`(${numVal.source}|${constName.source})`);

  for (const file of fileSet) {
    const content = fs.readFileSync(path.join(distDir, file), 'utf8');

    // Step 1: collect numeric constants (const FOO = 272e3)
    const constants: Record<string, number> = {};
    const constRe = /\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*(\d+(?:\.\d+)?(?:[eE]\d+)?)\b/g;
    let cm: RegExpExecArray | null;
    while ((cm = constRe.exec(content)) !== null) {
      constants[cm[1]] = Number(cm[2]);
    }

    function resolveVal(raw: string): number | null {
      const n = Number(raw);
      return isNaN(n) ? (constants[raw] ?? null) : n;
    }

    // Step 2a — Format A: "model-id": { ... contextWindow: VALUE ...
    // Use a 800-char lookahead after the opening brace to skip nested objects.
    const reA = /"([^"]+)"\s*:\s*\{/g;
    let mA: RegExpExecArray | null;
    while ((mA = reA.exec(content)) !== null) {
      const id = mA[1];
      const chunk = content.slice(mA.index + mA[0].length, mA.index + mA[0].length + 800);
      const cw = chunk.match(new RegExp(`\\bcontextWindow\\s*:\\s*${valPat.source}`));
      if (cw) {
        const val = resolveVal(cw[1]);
        if (val && val >= 1000) results[id] = val;
      }
    }

    // Step 2b — Format B: id: "model-id" ... contextWindow: VALUE
    // Look within 800 chars after the id field.
    const reB = /\bid\s*:\s*"([^"]+)"/g;
    let mB: RegExpExecArray | null;
    while ((mB = reB.exec(content)) !== null) {
      const id = mB[1];
      const chunk = content.slice(mB.index, mB.index + 800);
      const cw = chunk.match(new RegExp(`\\bcontextWindow\\s*:\\s*${valPat.source}`));
      if (cw) {
        const val = resolveVal(cw[1]);
        if (val && val >= 1000) results[id] = val;
      }
    }

    // Step 2c — Format C: const PREFIX_MODEL_ID = "model-id" + const PREFIX_CONTEXT_TOKENS/WINDOW = N
    // Used by openai-codex-provider and similar files where model id and context limit
    // are declared as sibling constants sharing a common name prefix.
    const modelIdConsts = new Map<string, string>();  // prefix → model-id string
    const modelIdRe = /\bconst\s+([A-Z_][A-Z0-9_]*_MODEL_ID)\s*=\s*"([^"]+)"/g;
    let mC: RegExpExecArray | null;
    while ((mC = modelIdRe.exec(content)) !== null) {
      const prefix = mC[1].replace(/_MODEL_ID$/, '');
      modelIdConsts.set(prefix, mC[2]);
    }
    for (const [prefix, modelId] of modelIdConsts) {
      // Match PREFIX_CONTEXT_TOKENS or PREFIX_CONTEXT_WINDOW
      const cwRe = new RegExp(
        `\\bconst\\s+${prefix}_CONTEXT(?:_TOKENS|_WINDOW)\\s*=\\s*(\\d+(?:\\.\\d+)?(?:[eE]\\d+)?)\\b`
      );
      const cw = content.match(cwRe);
      if (cw) {
        const val = Number(cw[1]);
        if (val >= 1000) results[modelId] = val;
      }
    }
  }
  return results;
}

/**
 * Load model context window data from the locally installed OpenClaw package.
 * Merges into MODEL_CONTEXT_WINDOW (OpenClaw values take priority).
 * Call once at server startup.
 */
export function loadOpenClawModelDefinitions(): number {
  const dir = findOpenClawDir();
  if (!dir) return 0;

  const distDir = path.join(dir, 'dist');
  if (!fs.existsSync(distDir)) return 0;

  const loaded = parseModelDefinitions(distDir);
  let count = 0;
  for (const [id, cw] of Object.entries(loaded)) {
    MODEL_CONTEXT_WINDOW[id] = cw;
    count++;
  }
  return count;
}

/* ── Model Pricing (per token) ───────────────────────────────────────── */

interface ModelPricing {
  input: number;       // $/token
  output: number;      // $/token
  cacheRead: number;   // $/token
}

/** Pricing per token (not per MTok). Multiply by 1_000_000 to get $/MTok. */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 4.x
  'claude-opus-4':     { input: 15   / 1e6, output: 75   / 1e6, cacheRead: 1.50  / 1e6 },
  'claude-sonnet-4':   { input: 3    / 1e6, output: 15   / 1e6, cacheRead: 0.30  / 1e6 },
  'claude-haiku-4':    { input: 0.80 / 1e6, output: 4    / 1e6, cacheRead: 0.08  / 1e6 },
  // Claude 3.x
  'claude-3-5-sonnet': { input: 3    / 1e6, output: 15   / 1e6, cacheRead: 0.30  / 1e6 },
  'claude-3-5-haiku':  { input: 0.80 / 1e6, output: 4    / 1e6, cacheRead: 0.08  / 1e6 },
  'claude-3-opus':     { input: 15   / 1e6, output: 75   / 1e6, cacheRead: 1.50  / 1e6 },
  'claude-3-haiku':    { input: 0.25 / 1e6, output: 1.25 / 1e6, cacheRead: 0.03  / 1e6 },
  // GPT 5.x
  'gpt-5.2-codex':     { input: 1.75 / 1e6, output: 14   / 1e6, cacheRead: 0.175 / 1e6 },
  'gpt-5.1-codex':     { input: 1.50 / 1e6, output: 12   / 1e6, cacheRead: 0.15  / 1e6 },
  'gpt-5.1-codex-mini':{ input: 0.75 / 1e6, output: 3    / 1e6, cacheRead: 0.075 / 1e6 },
  'gpt-5':             { input: 10   / 1e6, output: 30   / 1e6, cacheRead: 2.50  / 1e6 },
  // GPT 4.x
  'gpt-4o':            { input: 2.50 / 1e6, output: 10   / 1e6, cacheRead: 1.25  / 1e6 },
  'gpt-4o-mini':       { input: 0.15 / 1e6, output: 0.60 / 1e6, cacheRead: 0.075 / 1e6 },
  'gpt-4-turbo':       { input: 10   / 1e6, output: 30   / 1e6, cacheRead: 5     / 1e6 },
  // Reasoning models
  'o3':                { input: 10   / 1e6, output: 40   / 1e6, cacheRead: 2.50  / 1e6 },
  'o4-mini':           { input: 1.10 / 1e6, output: 4.40 / 1e6, cacheRead: 0.275 / 1e6 },
  'o1':                { input: 15   / 1e6, output: 60   / 1e6, cacheRead: 7.50  / 1e6 },
  // Gemini
  'gemini-2.0-flash':  { input: 0.10 / 1e6, output: 0.40 / 1e6, cacheRead: 0.025 / 1e6 },
  'gemini-1.5-pro':    { input: 1.25 / 1e6, output: 5    / 1e6, cacheRead: 0.3125/ 1e6 },
  'gemini-1.5-flash':  { input: 0.075/ 1e6, output: 0.30 / 1e6, cacheRead: 0.01875/1e6 },
  // GLM (Zhipu)
  'glm-5.1':           { input: 1.20 / 1e6, output: 4    / 1e6, cacheRead: 0.24  / 1e6 },
  // Qwen
  'qwen3.6-plus':      { input: 0.80 / 1e6, output: 2    / 1e6, cacheRead: 0.20  / 1e6 },
};

/** Default pricing when model is unknown — uses Sonnet pricing as baseline. */
const DEFAULT_PRICING: ModelPricing = {
  input: 3 / 1e6, output: 15 / 1e6, cacheRead: 0.30 / 1e6,
};

/**
 * Look up pricing for a model. Uses prefix matching then substring fallback.
 */
function getModelPricing(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;

  // Exact match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Prefix match — sort by key length descending so longer prefixes match first
  for (const [key, pricing] of Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length)) {
    if (model.startsWith(key)) return pricing;
  }

  // OpenRouter strip
  if (model.includes('/')) {
    const sub = model.split('/').slice(1).join('/');
    if (sub && sub !== model) return getModelPricing(sub);
  }

  // Substring fallback
  const m = model.toLowerCase();
  if (m.includes('opus'))    return MODEL_PRICING['claude-opus-4'] ?? DEFAULT_PRICING;
  if (m.includes('haiku'))   return MODEL_PRICING['claude-haiku-4'] ?? DEFAULT_PRICING;
  if (m.includes('sonnet'))  return MODEL_PRICING['claude-sonnet-4'] ?? DEFAULT_PRICING;
  if (m.includes('codex'))   return MODEL_PRICING['gpt-5.2-codex'] ?? DEFAULT_PRICING;
  if (m.includes('gemini'))  return MODEL_PRICING['gemini-2.0-flash'] ?? DEFAULT_PRICING;
  if (m.includes('glm'))     return MODEL_PRICING['glm-5.1'] ?? DEFAULT_PRICING;
  if (m.includes('qwen'))    return MODEL_PRICING['qwen3.6-plus'] ?? DEFAULT_PRICING;
  if (m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return MODEL_PRICING['o3'] ?? DEFAULT_PRICING;
  if (m.includes('gpt'))     return MODEL_PRICING['gpt-4o'] ?? DEFAULT_PRICING;

  return DEFAULT_PRICING;
}

/* ── Percentile Utility ──────────────────────────────────────────────── */

/**
 * Compute the p-th percentile from a pre-sorted array using nearest-rank method.
 * @param sorted - array sorted ascending
 * @param p - percentile in [0, 1], e.g. 0.95 for P95
 */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.min(i, sorted.length - 1)];
}
