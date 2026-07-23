import type { MemoryConfig } from "../config/types.js";
import { errorMessage, errorName } from "../types/errors.js";
import type { InboundMessage } from "../types/events.js";
import {
  buildContextCompressionMessages,
  parseContextCompressionResult
} from "./compress-context.js";
import type { Memory } from "./memory.js";
import { summarizeLogText, writeLog } from "../utils/log.js";
import type { Model, ModelMessage } from "../model/index.js";

async function collectModelText(model: Model, messages: ModelMessage[]): Promise<string> {
  const parts: string[] = [];
  for await (const event of model.streamChat(messages, [])) {
    if (event.type === "model_text_delta") {
      parts.push(event.text);
    }
  }
  const text = parts.join("");
  if (!text.trim()) {
    throw new Error("上下文压缩模型未返回文本");
  }
  return text;
}

async function compressContextIfNeeded(
  config: MemoryConfig,
  model: Model,
  memory: Memory,
  turnId: string
): Promise<void> {
  if (!config.compressContext) {
    return;
  }
  let state = memory.shortTerm.loadState();
  let changed = false;
  try {
    while (state.turns.length >= config.contextTurns) {
      const batchSize = Math.min(config.compressBatch, state.turns.length);
      if (batchSize <= 0) {
        break;
      }
      const batch = state.turns.slice(0, batchSize);
      const response = await collectModelText(
        model,
        buildContextCompressionMessages(state.summary, batch)
      );
      const summary = parseContextCompressionResult(response);
      state = {
        summary: summary || state.summary,
        turns: state.turns.slice(batchSize)
      };
      changed = true;
    }
    if (changed) {
      await memory.shortTerm.saveState(state);
    }
  } catch (error) {
    writeLog("error", "memory", {
      turnId,
      type: "context_compression_error",
      errorName: errorName(error),
      content: summarizeLogText(errorMessage(error))
    });
  }
}

export async function commitTurn(
  config: MemoryConfig,
  model: Model,
  memory: Memory,
  inbound: InboundMessage,
  assistantReply: string,
  turnId: string
): Promise<void> {
  await compressContextIfNeeded(config, model, memory, turnId);
  await memory.shortTerm.append(inbound.text, assistantReply, inbound.platform);
}
