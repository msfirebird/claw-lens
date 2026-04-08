/**
 * Estimate token sections from OpenClaw system prompt text.
 * Sections are identified by ## headings in the prompt.
 * Returns: tooling, workspace (injected files), memory, and base (everything else).
 */
export interface PromptSectionEstimate {
  label: string;
  tokens: number;
  hint: string;
}

export function estimateSections(text: string | null | undefined): PromptSectionEstimate[] {
  if (!text) return [];
  const est = (s: string) => Math.ceil(s.length / 4);
  const total = est(text);
  if (total === 0) return [];

  let toolingTokens = 0;
  let workspaceTokens = 0;
  let memoryTokens = 0;

  // Split by ## headings and classify
  const parts = text.split(/^(?=## )/m);
  for (const part of parts) {
    const heading = part.split('\n')[0].toLowerCase();
    const t = est(part);

    if (heading.includes('tooling') || heading.includes('tool call style') || heading.includes('cli quick reference')) {
      toolingTokens += t;
    } else if (heading.includes('workspace files') || heading.includes('/users/') || heading.includes('agents.md') || heading.includes('soul.md') || heading.includes('tools.md') || heading.includes('identity.md') || heading.includes('user.md') || heading.includes('heartbeat.md') || heading.includes('bootstrap.md')) {
      workspaceTokens += t;
    } else if (heading.includes('memory') || heading.includes('memory.md')) {
      memoryTokens += t;
    }
  }

  const baseTokens = Math.max(0, total - toolingTokens - workspaceTokens - memoryTokens);

  const result: PromptSectionEstimate[] = [];
  if (baseTokens > 0) result.push({ label: 'Base', tokens: baseTokens, hint: 'safety rules, skills, messaging, reply format' });
  if (toolingTokens > 0) result.push({ label: 'Tooling', tokens: toolingTokens, hint: 'tool definitions, CLI reference, call style' });
  if (workspaceTokens > 0) result.push({ label: 'Workspace', tokens: workspaceTokens, hint: 'injected files — AGENTS.md, SOUL.md, USER.md, etc.' });
  if (memoryTokens > 0) result.push({ label: 'Memory', tokens: memoryTokens, hint: 'MEMORY.md — persistent notes, preferences, decisions' });

  return result;
}
