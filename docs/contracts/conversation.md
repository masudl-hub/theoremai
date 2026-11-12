# Conversation (`@theoremjs/agents/conversation`)

Use this layer when items reach a conversation while a reply may be running: a background call that ended, a due reminder, or a fact from outside. It makes sure one reply at a time reads the conversation, and that each item is told to the model exactly once, or given up and reported once.

The layer has no HTTP and no transcript. The app gives two things:

- **The inbox** (`ConversationInbox`): the app's storage for each conversation's lock and its untold items.
- **The policy** (`InboxPolicy`): the app's rule for what the model may be told now, such as quiet hours or a cap.

`runConversation` runs each reply under a **hold**: a lease on the conversation that one reply (or a chain of replies) has. The web handler in `@theoremjs/web/server` is one caller. Its inbox keeps the lock in the session store (`web/src/server/conversation-inbox.ts`).

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/conversation` / `jsr:@theoremjs/agents/conversation` |
| Module | `src/conversation/mod.ts` |
| Test import | `@theoremjs/agents/conversation/testing` / `jsr:@theoremjs/agents/conversation/testing` |
| Test module | `src/conversation/testing.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/conversation/types.ts` | The contract: `ConversationInbox`, `InboxPolicy`, `ReplyRun`, `ConversationRun` |
| `src/conversation/run.ts` | `runConversation`: open, renew, read, hand, give back, release |
| `src/conversation/memory.ts` | `createMemoryInbox`: an inbox in process memory, for tests and one-process apps |
| `src/conversation/testing.ts` | `conversationScenarios`: the scenarios every inbox must pass |
| `src/conversation/mod.ts` | Public barrel |

## Rules that must stay true

1. **Saved first.** An item is in the inbox before anything tells it. A wake is a nudge, not a delivery: it can come twice, late, or not at all.
2. **One hold at a time.** `open` gives the conversation to one hold, on a lease. A person's message uses `takeOver`: the old hold can no longer renew, hand, or save. An app that takes the conversation itself, such as in the write that saves the person's message, names that hold in `ReplyStart.hold`. `open` with the hold that has the conversation keeps it.
3. **Told means saved.** The reply's own save marks what it told, in the same write as the reply, and only while its hold still has the conversation. A reply that fails gives back what it read, with the handover kept, so a later reply can say what came of it.
4. **The fence.** A reply checks its hold before each save. A reply whose hold lost the conversation saves nothing.
5. **Release has a version check.** `release` lets the conversation go only while the inbox version is the one the last read saw. An item that arrives between the policy's answer and the release moves the version, so the hold reads again.
6. **Only tellable items keep the hold.** At the end of a reply, the policy is asked at `opening: 'follow_up'`. If it tells something, the run ends `continue`, and the caller runs a follow-up under the same hold. An item the policy holds back does not start reply after reply.
7. **The policy changes nothing.** The runner asks it again at each moment.

## The run

```
  open / takeOver ──► take(pre_turn) ──► reply(run) ──► giveBack (untold)
        │                                    │
        │ held: another hold has it          ├─ take(post_tool), take(before_end)
        ▼                                    ▼
  { outcome: 'held', leasedUntil }    policy at follow_up
                                       ├─ tells something ──► { outcome: 'continue', hold }
                                       └─ tells nothing  ──► release(version)
                                                              ├─ released ──► { outcome: 'released' }
                                                              ├─ moved    ──► read again
                                                              └─ lost     ──► { outcome: 'lost' }
```

- A `wake` or a `follow_up` with nothing to tell as it opens runs no reply.
- A `message` always runs its reply, with or without items.
- The hold renews every `renewEveryMs`. A renewal that fails aborts `ReplyRun.signal`.
- `failure` on the result is what the reply threw. The items were given back first. The caller reports it.
- `gaveUp` is called once with the items the policy gave up, at the moment it gave them up.

## Paused replies

A reply that stops on a gate keeps what it read. The pause save marks those items for that reply, past any lease. When the person answers, the reply that goes on calls `ReplyRun.resume(paused)` to take them back. If it fails, they go back to the paused reply, not to the inbox.

| What happens | Where the item goes |
| --- | --- |
| The reply pauses on a gate | Kept for the paused reply, past any lease. `read` does not return it |
| The reply that goes on calls `resume` and is saved | Told |
| The reply that goes on fails | Back to the paused reply |
| The reply that goes on pauses again | Kept for the new pause |

## Scenarios

`conversationScenarios({ makeHarness })` returns one scenario for each awkward moment: an item that arrives before a reply, during a step, while the reply saves, and as the hold lets go; two replies that open at once; a lease that runs out; a paused reply; and a reply that throws. Run each one as a test against your own inbox. The harness does the app's own writes: `arrive`, `settle`, `pause`, `lapse`, and `told`.

| Harness member | What the app's version does |
| --- | --- |
| `arrive(id)` | Saves an item, and moves the inbox version |
| `settle(hold, reply, ids)` | A reply's save: marks `ids` told, only while `hold` has the conversation and `reply` was given each id |
| `pause(hold, reply, ids)` | A paused reply's save, with the same check |
| `lapse()` | Moves the clock past every lease |
| `told()` | The ids told so far, once for each time one was told |

`tests/conversation/memory.test.ts` runs them against `createMemoryInbox`. `tests/web/conversation-inbox.test.ts` runs them against the web handler's session-store inbox.

## Exported API

| Export | Role |
| --- | --- |
| `ConversationInbox`, `Opened`, `InboxRead`, `Handover`, `InboxItem` | The storage contract the app implements |
| `InboxPolicy`, `PolicyChoice`, `PolicyMoment`, `TakeAt` | The app's rule for what the model may be told now |
| `runConversation`, `RunConversationOptions` | Runs one reply under a hold |
| `ReplyStart`, `ReplyRun`, `ConversationRun` | What opens a reply, what the reply gets, and how the run ended |
| `createMemoryInbox`, `MemoryInbox`, `MemoryInboxOptions`, `ItemState` | An inbox in process memory |
| `conversationScenarios`, `ConversationScenariosOptions`, `ConversationScenario`, `ScenarioHarness` | The scenarios every inbox must pass (test import) |

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/conversation/mod.ts" },
        { "kind": "config", "path": "deno.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/conversation/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Rules that must stay true": {
      "supports": [
        { "kind": "source", "path": "src/conversation/run.ts" },
        { "kind": "contract_test", "path": "tests/conversation/run.test.ts" }
      ]
    },
    "The run": {
      "supports": [
        { "kind": "source", "path": "src/conversation/run.ts" },
        { "kind": "contract_test", "path": "tests/conversation/run.test.ts" }
      ]
    },
    "Paused replies": {
      "supports": [
        { "kind": "source", "path": "src/conversation/memory.ts" },
        { "kind": "contract_test", "path": "tests/conversation/memory.test.ts" }
      ]
    },
    "Scenarios": {
      "supports": [
        { "kind": "source", "path": "src/conversation/testing.ts" },
        { "kind": "contract_test", "path": "tests/conversation/memory.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/conversation/mod.ts" },
        { "kind": "contract_test", "path": "tests/conversation/run.test.ts" }
      ]
    }
  }
}
```
