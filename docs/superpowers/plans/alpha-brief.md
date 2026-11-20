# Ole alpha: shared brief for parallel workers

Goal: functional alpha within the hour. Ole = tracking fork of Yogurt (Electron 44, TS, pnpm 10.7 workspace, app code in `app/`).
Repo: `~/Documents/Workspace/Other/ole`. Spec: `docs/superpowers/specs/2026-11-19-ole-design.md`. Plan: `docs/superpowers/plans/2026-11-19-ole-fork-foundation.md`.

## Rules for every worker

- Several workers share ONE working tree. Create/edit ONLY the files your task names. Do not edit any other file, do not run `git add/commit/stash/checkout/reset`, do not run `pnpm install`. The lead integrates and commits.
- Tests: Vitest. From `app/`: `npx -y pnpm@10.7.0 exec vitest run test/ole/<file>.test.ts`. Typecheck: `npx -y pnpm@10.7.0 typecheck` (other workers' files may be mid-edit; judge only errors in your files).
- Look at existing tests (`app/test/*.test.ts`, electron is mocked via `vi.mock('electron')`) for style.
- Code drafting rule (owner's standing policy): the first draft of code comes from the self-hosted model, then you review every line, fix, and test. Call it like this (never print the key):

```bash
KEY=$(security find-generic-password -s llm-cjett-net -w)
curl -s -N https://llm.cjett.net/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'User-Agent: claude-draft/1' -d @req.json
# req.json: {"model":"default","stream":true,"max_tokens":3000,"messages":[{"role":"user","content":"<spec + relevant code excerpts>"}]}
```
  Stream output is SSE; concatenate `choices[0].delta.content`. The box has one slot; if it is slow (>90s with no tokens) or broken, write it yourself and say so. Put request files in `/private/tmp/claude-501/-Users-coryjett-Documents-Workspace-Solo-siesta/d106c82e-a824-439e-b94b-c493bc23d787/scratchpad/`.
- No em dashes or arrows in comments. Match Yogurt's code style (read neighbouring files). No customer names anywhere.
- Never log or return secrets. No network calls in tests (inject `fetch`).
- Final report (short): files created, exported signatures, test results (pass counts), which parts the box drafted vs you wrote, anything the lead must wire.

## Shared types (use these exact names)

```ts
// app/src/main/ole/types.ts  (owned by the lead; already exists, import from it)
export type SecretName = 'openai' | 'siesta';
export type ProviderChoice = 'local' | 'openai';
export type OleProviders = { transcription: ProviderChoice; assistant: ProviderChoice; openaiTranscribeModel: string; openaiChatModel: string };
export type OleBullet = { id: string; text: string; source: string; at: number };
export type PreparedContext = { meetingTitle: string | null; accountId: string | null; accountName: string | null; text: string; preparedAt: number };
```
