import { LongTermMemory } from "./long-term-memory.js";
import { ShortTermMemory } from "./short-term-memory.js";

/** 短期记忆压缩策略。 */
export type MemoryCompression = {
  compressBatch: number;
  compressContext: boolean;
};

/** 统一记忆入口：短期对话上下文 + 长期持久记忆。 */
export class Memory {
  constructor(
    readonly shortTerm: ShortTermMemory,
    readonly longTerm: LongTermMemory,
    readonly compression: MemoryCompression = {
      compressBatch: 1,
      compressContext: false
    }
  ) {}
}
