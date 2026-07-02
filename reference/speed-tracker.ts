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
 * hook-call deltas. Each assistant message's tokens are attributed to the span from the last
 * preceding user entry (real input or a tool_result) to that message's own timestamp — tool
 * execution time falls in the gap between an assistant entry and the next user entry, so it's
 * never counted as generation time. This also makes every stat available as soon as one turn
 * exists in the transcript, regardless of how often (or rarely) the statusline hook itself gets
 * invoked.
 *
 * Messages are tracked in a map keyed by message.id rather than a single "current message"
 * slot, because a single logical message with multiple tool_use blocks can have its blocks
 * interleaved with `user`-role tool_result entries for the *earlier* blocks while *later* blocks
 * of the same message are still being logged — the same message.id can reappear after one or
 * more intervening `user` entries. Finalizing on every `user` entry (a single running "current"
 * slot) would close that message prematurely and then reopen it, re-attributing its full token
 * count to each remaining fragment over a near-zero duration — producing readings in the
 * thousands of tok/s. Keying by message.id fixes the interval's start at first sighting and
 * keeps extending its end as later blocks for the same id arrive, regardless of what's
 * interleaved in between.
 */
function collectIntervals(transcriptPath: string): SpeedInterval[] {
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const messages = new Map<string, { startMs: number | null; endMs: number; tokens: number }>();

  let lastUserMs: number | null = null;

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
      lastUserMs = ms;
      continue;
    }

    if (entry.type === 'assistant') {
      const msgId = entry.message?.id;
      const outputTokens = entry.message?.usage?.output_tokens;
      if (!msgId || typeof outputTokens !== 'number') continue;

      const existing = messages.get(msgId);
      if (existing) {
        existing.endMs = ms;
        existing.tokens = outputTokens;
      } else {
        messages.set(msgId, { startMs: lastUserMs, endMs: ms, tokens: outputTokens });
      }
    }
  }

  const intervals: SpeedInterval[] = [];
  for (const { startMs, endMs, tokens } of messages.values()) {
    if (startMs !== null && endMs > startMs && tokens > 0) {
      intervals.push({ startMs, endMs, tokens });
    }
  }
  intervals.sort((a, b) => a.endMs - b.endMs);
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
