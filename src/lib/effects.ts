// ============================================================
// The outcome of a side effect run on behalf of a durable task (the
// inbound fan-out outbox, migration 070). Executors say what happened
// instead of swallowing failures, so the task is completed only when it
// should be (fourth review K4):
//
//   ok         — the effect happened.
//   noop       — nothing to do (no matching flow, auto-reply off, no
//                endpoint subscribed…): deliberately no effect.
//   retry      — it failed BEFORE any effect (a lookup, a load, a call
//                that provably didn't go out): safe to run again.
//   uncertain  — it failed after an effect may have happened: running it
//                again could duplicate it, so a person looks at it.
// ============================================================

export type EffectOutcome = 'ok' | 'noop' | 'retry' | 'uncertain'
