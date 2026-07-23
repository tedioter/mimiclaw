type FenceState = {
  open: boolean;
  marker: string;
  info: string;
};

type MarkdownState = FenceState & {
  inlineCodeMarker: string;
  strongMarker: string;
  emphasisMarker: string;
  strikeOpen: boolean;
  linkLabelDepth: number;
  linkDestinationDepth: number;
};

const FENCE_LINE = /^(```+)(.*)$/;

function scanMarkdownState(text: string, until: number): MarkdownState {
  const end = Math.min(until, text.length);
  let fence: FenceState = { open: false, marker: "```", info: "" };
  let inlineCodeMarker = "";
  let strongMarker = "";
  let emphasisMarker = "";
  let strikeOpen = false;
  let linkLabelDepth = 0;
  let linkDestinationDepth = 0;
  let index = 0;

  while (index < end) {
    const atLineStart = index === 0 || text[index - 1] === "\n";
    if (atLineStart) {
      const lineEnd = text.indexOf("\n", index);
      if (lineEnd !== -1 && lineEnd < end) {
        const match = FENCE_LINE.exec(text.slice(index, lineEnd));
        if (match) {
          const marker = match[1] ?? "```";
          const info = match[2] ?? "";
          if (!fence.open) {
            fence = { open: true, marker, info };
          } else if (marker.length >= fence.marker.length && !info.trim()) {
            fence = { open: false, marker: "```", info: "" };
          }
          index = lineEnd + 1;
          continue;
        }
      }
    }

    if (fence.open) {
      index += 1;
      continue;
    }

    const current = text[index];
    if (current === "\\") {
      index += Math.min(2, end - index);
      continue;
    }
    if (current === "`") {
      let length = 1;
      while (text[index + length] === "`") {
        length += 1;
      }
      const marker = "`".repeat(length);
      if (!inlineCodeMarker) {
        inlineCodeMarker = marker;
      } else if (length >= inlineCodeMarker.length) {
        inlineCodeMarker = "";
      }
      index += length;
      continue;
    }
    if (inlineCodeMarker) {
      index += 1;
      continue;
    }
    if (text.startsWith("~~", index)) {
      strikeOpen = !strikeOpen;
      index += 2;
      continue;
    }
    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      const marker = text.slice(index, index + 2);
      strongMarker = strongMarker === marker ? "" : strongMarker || marker;
      index += 2;
      continue;
    }
    if (current === "*" || current === "_") {
      const previous = text[index - 1] ?? "";
      const next = text[index + 1] ?? "";
      const isWordUnderscore =
        current === "_" && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
      if (!isWordUnderscore) {
        emphasisMarker = emphasisMarker === current ? "" : emphasisMarker || current;
      }
      index += 1;
      continue;
    }
    if (current === "[") {
      linkLabelDepth += 1;
      index += 1;
      continue;
    }
    if (current === "]" && linkLabelDepth > 0) {
      linkLabelDepth -= 1;
      if (text[index + 1] === "(") {
        linkDestinationDepth = 1;
      }
      index += 1;
      continue;
    }
    if (linkDestinationDepth > 0) {
      if (current === "(") {
        linkDestinationDepth += 1;
      } else if (current === ")") {
        linkDestinationDepth -= 1;
      }
    }
    index += 1;
  }

  return {
    ...fence,
    inlineCodeMarker,
    strongMarker,
    emphasisMarker,
    strikeOpen,
    linkLabelDepth,
    linkDestinationDepth
  };
}

function markdownStateIsClosed(state: MarkdownState): boolean {
  return (
    !state.open &&
    !state.inlineCodeMarker &&
    !state.strongMarker &&
    !state.emphasisMarker &&
    !state.strikeOpen &&
    state.linkLabelDepth === 0 &&
    state.linkDestinationDepth === 0
  );
}

function lastBreakOutsideMarkdown(text: string, limit: number, delimiter: string): number {
  const minPos = Math.floor(limit / 3);
  let from = Math.min(limit, text.length);
  while (from > minPos) {
    const index = text.lastIndexOf(delimiter, from - 1);
    if (index < 0 || index < minPos) {
      return -1;
    }
    const position = index + delimiter.length;
    if (markdownStateIsClosed(scanMarkdownState(text, position))) {
      return position;
    }
    from = index;
  }
  return -1;
}

function lastSafeMarkdownPosition(text: string, limit: number): number {
  const minPos = Math.floor(limit / 3);
  for (let position = Math.min(limit, text.length); position > minPos; position -= 1) {
    const previous = text[position - 1] ?? "";
    if (!/[\s，。！？；：,.!?;:]/u.test(previous)) {
      continue;
    }
    if (markdownStateIsClosed(scanMarkdownState(text, position))) {
      return position;
    }
  }
  return -1;
}

function findSplitPosition(text: string, limit: number): number {
  const capped = Math.min(limit, text.length);
  for (const delimiter of ["\n\n", "\n", "。"] as const) {
    const position = lastBreakOutsideMarkdown(text, capped, delimiter);
    if (position > 0) {
      return safeUnicodeBoundary(text, position);
    }
  }
  const safePosition = lastSafeMarkdownPosition(text, capped);
  if (safePosition > 0) {
    return safeUnicodeBoundary(text, safePosition);
  }
  return safeUnicodeBoundary(text, capped);
}

function markdownRepair(state: MarkdownState): { suffix: string; prefix: string } {
  let suffix = "";
  let prefix = "";
  if (state.open) {
    suffix += `\n${state.marker}`;
    prefix += `${state.marker}${state.info}\n`;
  }
  if (state.inlineCodeMarker) {
    suffix += state.inlineCodeMarker;
    prefix = `${state.inlineCodeMarker}${prefix}`;
  }
  if (state.strikeOpen) {
    suffix += "~~";
    prefix = `~~${prefix}`;
  }
  if (state.emphasisMarker) {
    suffix += state.emphasisMarker;
    prefix = `${state.emphasisMarker}${prefix}`;
  }
  if (state.strongMarker) {
    suffix += state.strongMarker;
    prefix = `${state.strongMarker}${prefix}`;
  }
  return { suffix, prefix };
}

/** 取出不超过 limit 的一段；若切在 Markdown 结构内，会闭合本段并在 rest 开头重开结构。 */
export function takeSplitChunk(text: string, limit: number): { chunk: string; rest: string } {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("消息分段上限必须是正整数");
  }
  if (text.length <= limit) {
    return { chunk: text, rest: "" };
  }

  let workingLimit = limit;
  const stateAtLimit = scanMarkdownState(text, limit);
  const repairAtLimit = markdownRepair(stateAtLimit);
  if (repairAtLimit.suffix) {
    workingLimit = Math.max(1, limit - repairAtLimit.suffix.length);
  }

  let position = findSplitPosition(text, workingLimit);
  if (position <= 0) {
    position = safeUnicodeBoundary(text, Math.min(workingLimit, text.length));
  }
  if (position <= 0) {
    position = safeUnicodeBoundary(text, Math.min(limit, text.length));
  }
  if (position >= text.length) {
    return { chunk: text, rest: "" };
  }
  if (position <= 0) {
    position = Math.min(limit, text.length);
    position = safeUnicodeBoundary(text, position);
  }

  let chunk = text.slice(0, position);
  let rest = text.slice(position);
  const repair = markdownRepair(scanMarkdownState(text, position));
  if (repair.suffix) {
    chunk += repair.suffix;
    rest = `${repair.prefix}${rest}`;
  }
  return { chunk, rest };
}

export function splitText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("消息分段上限必须是正整数");
  }
  if (!text) {
    return [];
  }
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    const { chunk, rest } = takeSplitChunk(remaining, limit);
    if (!chunk) {
      const forced = safeUnicodeBoundary(remaining, Math.min(limit, remaining.length)) || 1;
      chunks.push(remaining.slice(0, forced));
      remaining = remaining.slice(forced);
      continue;
    }
    chunks.push(chunk);
    remaining = rest;
  }
  return chunks;
}

function safeUnicodeBoundary(text: string, position: number): number {
  if (position <= 0 || position >= text.length) {
    return position;
  }
  const previous = text.charCodeAt(position - 1);
  const current = text.charCodeAt(position);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    return position === 1 ? position + 1 : position - 1;
  }
  return position;
}
