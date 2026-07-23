import { createHash, randomUUID } from "node:crypto";
import type { InboundMessage } from "../types/events.js";

const TURN_ID_HASH_LENGTH = 8;

export function buildTurnId(inbound: Pick<InboundMessage, "platform" | "messageId">): string {
  if (inbound.messageId) {
    const digest = createHash("sha256")
      .update(inbound.messageId)
      .digest("hex")
      .slice(0, TURN_ID_HASH_LENGTH);
    return `${inbound.platform}:${digest}`;
  }
  const digest = randomUUID().replace(/-/g, "").slice(0, TURN_ID_HASH_LENGTH);
  return `${inbound.platform}:${digest}`;
}
