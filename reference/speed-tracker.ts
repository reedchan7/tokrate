import * as fs from 'node:fs';
import type { StdinData } from './types.js';

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    usage?: { output_tokens?: number };
  };
}

interface SpeedInterval {
  startMs: number;
  endMs: number;
  tokens: number;
}

export interface SpeedReading {
  speed: number;
  stats: {
    max: number;
    min: number;
    avg: number;
  };
}

/**
 * Reconstructs per-turn output-token intervals from the session transcript instead of sampling
 * hook-call deltas. Each assistant message's tokens are attributed to the span from the preceding
 * user entry (real input or a tool_result) to that message's own timestamp — tool-execution time
 * falls in the gap between an assistant entry and the next user entry, so it's never counted as
 * generation time. This also makes every stat available as soon as one turn exists in the
 * transcript, regardless of how often (or rarely) the statusline hook itself gets invoked.
 */
function collectIntervals(transcriptPath: string): SpeedInterval[] {
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const intervals: SpeedInterval[] = [];

  let lastUserMs: number | null = null;
  let currentMsgId: string | null = null;
  let currentStartMs: number | null = null;
  let currentEndMs = 0;
  let currentTokens = 0;

  const finalizeCurrent = () => {
    if (currentMsgId !== null && currentStartMs !== null && currentEndMs > currentStartMs && currentTokens > 0) {
      intervals.push({ startMs: currentStartMs, endMs: currentEndMs, tokens: currentTokens });
    }
    currentMsgId = null;
    currentStartMs = null;
    currentEndMs = 0;
    currentTokens = 0;
  };

  for (const line of content.split('\n')) {
    if (!line) continue;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (entry.isSidechain) continue;

    const ms = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;

    if (entry.type === 'user') {
      finalizeCurrent();
      lastUserMs = ms;
      continue;
    }

    if (entry.type === 'assistant') {
      const msgId = entry.message?.id;
      const outputTokens = entry.message?.usage?.output_tokens;
      if (!msgId || typeof outputTokens !== 'number') continue;

      if (msgId !== currentMsgId) {
        finalizeCurrent();
        currentMsgId = msgId;
        currentStartMs = lastUserMs;
      }
      currentEndMs = ms;
      currentTokens = outputTokens;
    }
  }

  finalizeCurrent();
  return intervals;
}

export function getOutputSpeed(stdin: StdinData): SpeedReading | null {
  const transcriptPath = stdin.transcript_path;
  if (!transcriptPath) return null;

  let intervals: SpeedInterval[];
  try {
    intervals = collectIntervals(transcriptPath);
  } catch {
    return null;
  }

  if (intervals.length === 0) return null;

  const rates = intervals.map(({ startMs, endMs, tokens }) => tokens / ((endMs - startMs) / 1000));
  const totalTokens = intervals.reduce((sum, i) => sum + i.tokens, 0);
  const totalMs = intervals.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);

  return {
    speed: rates[rates.length - 1] as number,
    stats: {
      max: Math.max(...rates),
      min: Math.min(...rates),
      avg: totalTokens / (totalMs / 1000),
    },
  };
}
