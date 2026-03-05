/**
 * Compile-time type compatibility test.
 *
 * Ensures SDK types stay in sync with the canonical API types.
 * If the API types change and the SDK types drift, this file will
 * fail to compile — CI catches drift before it reaches users.
 */
import { test, expect } from "bun:test";
import type {
  Conversation as APIConversation,
  Message as APIMessage,
  ConversationWithMessages as APIConversationWithMessages,
} from "@atlas/api/lib/conversation-types";
import type { ActionApprovalMode as APIActionApprovalMode } from "@atlas/api/lib/action-types";
import type { Conversation, Message, ConversationWithMessages, ActionApprovalMode } from "../client";

// Compile-time assignability checks — these lines fail to compile if types drift
type AssertAssignable<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;

const _convCompat: AssertAssignable<Conversation, APIConversation> = true;
const _msgCompat: AssertAssignable<Message, APIMessage> = true;
const _convWithMsgsCompat: AssertAssignable<ConversationWithMessages, APIConversationWithMessages> = true;
const _approvalModeCompat: AssertAssignable<ActionApprovalMode, APIActionApprovalMode> = true;

// Suppress unused-variable warnings — the assertions above are the real test
void _convCompat;
void _msgCompat;
void _convWithMsgsCompat;
void _approvalModeCompat;

test("SDK types are compatible with API types (compile-time check)", () => {
  // If this file compiles, the types are compatible.
  // This runtime assertion exists only so bun:test registers at least one test.
  expect(true).toBe(true);
});
