# Ole Plan 1: Fork Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ole runs as a renamed, self-contained tracking fork of Yogurt that can use OpenAI (the user's own key) for transcription and for the notes model, with keys stored encrypted.

**Architecture:** Merge Yogurt's history into the Ole repo with `upstream` as a remote. Rename only what users see and what would collide with a real Yogurt install; everything else keeps Yogurt's names so upstream merges stay cheap. Ole code lives in `app/src/main/ole/` and `app/src/renderer/src/ole/`; Yogurt files change only at a few named seams. OpenAI plugs in at Yogurt's two existing seams: the `Transcribe` function (`asr/`) and the `createNotesModel` surface (`notes/model.ts`).

**Tech Stack:** Electron 44, TypeScript, pnpm 10.7, Vitest 5, node:sqlite, electron-builder, Swift helpers (macOS).

**Spec:** `docs/superpowers/specs/2026-11-19-ole-design.md`. Plan 2 (Siesta context: MCP client, warm-up, bullets, no-account calls) follows this plan and is out of scope here.

## Global Constraints

- Tracking fork: Yogurt stays an `upstream` remote; never rewrite or squash its history.
- Ole-only code goes in `app/src/main/ole/`, `app/src/renderer/src/ole/`, `app/test/ole/`. Edits to Yogurt files are limited to the seams each task names.
- Keep Yogurt's LICENSE and copyright notice; credit Yogurt in README and About.
- Product name `Ole`; app id `net.cjett.ole`; helper bundle ids `net.cjett.ole.audio-helper`, `net.cjett.ole.mac-helper`, `net.cjett.ole.mcp`; data folder `~/Library/Application Support/Ole`.
- Internal identifiers stay Yogurt's: `window.yogurt`, `YOGURT_*` env vars, `native/yogurt-*` folder and binary names, `yogurt-audio` scheme, `yogurt.db` file name, i18n keys.
- Auto-update is off in v1 (`publish: null`); Ole must never fetch a Yogurt release.
- Secrets (OpenAI key, Siesta key) are sealed with Electron `safeStorage` and never returned to the renderer, logged, or written in plain text.
- OpenAI defaults (configurable in Settings, confirmed against `GET https://api.openai.com/v1/models` in Task 5): transcription `gpt-4o-mini-transcribe`, notes model `gpt-5.6-luna`.
- v1 targets macOS only; Windows and Linux builds are not touched or tested.
- No customer names anywhere in the repo.
- Commands run from `app/`: one test `pnpm exec vitest run test/<file>`, all `pnpm test`, types `pnpm typecheck`, build `pnpm build`.

## Review Focus

1. A real Yogurt install on the same Mac: Ole must not share its data folder, bundle ids, or MCP helper path. Pinned in Task 3 (`brand.test.ts`: data dir and ids).
2. Missing or wrong OpenAI key while recording: recording and audio keep going; transcription reports a warning instead of crashing, and the notes job fails with a readable error. Pinned in Task 6 and Task 7 (401 tests).
3. Network drop mid-call with OpenAI transcription: a failed chunk throws to the pipeline's warning path and later chunks still transcribe. Pinned in Task 7 (reject-then-succeed test).
4. The plain key reaching the renderer through `settings:get` or logs. Pinned in Task 4 (`settings:get` never contains the key; status is masked).
5. An auto-update check fetching Yogurt's releases. Pinned in Task 2 (builder config `publish` is null).

---

### Task 1: Bring Yogurt in as a tracking fork

**Files:**
- Create: `OLE.md` (repo root: what Ole is, Yogurt credit, how to merge upstream)
- Modify: `README.md` (prepend a short Ole header that links `OLE.md`; keep Yogurt's README below it)

**Interfaces:**
- Produces: a buildable repo with remotes `upstream` = `https://github.com/FrigadeHQ/yogurt.git`; Ole's existing `docs/` commits preserved.

- [ ] **Step 1: Add upstream and merge its history** into the existing Ole repo (which holds only `docs/`):

```bash
git remote add upstream https://github.com/FrigadeHQ/yogurt.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories -m "Merge Yogurt upstream as the base of Ole"
```

Expected: merge succeeds with no conflicts (Ole has only `docs/superpowers/`; resolve any `docs/` collision by keeping both).

- [ ] **Step 2: Install and verify the untouched base builds and passes**

Run: `pnpm install && cd app && pnpm typecheck && pnpm test`
Expected: typecheck exit 0; Vitest reports all test files passed. If any fail on a clean upstream, record them in `OLE.md` under "Known upstream failures" with their names before changing anything.

- [ ] **Step 3: Write `OLE.md`**: one paragraph on Ole (fork of Yogurt, MIT, by FrigadeHQ, with Siesta context), the rules from Global Constraints (where Ole code lives, seams only), and the merge routine: `git fetch upstream && git merge upstream/main`, then `pnpm install && pnpm --filter @yogurt/app typecheck && pnpm --filter @yogurt/app test`, resolve conflicts at seams, commit.

- [ ] **Step 4: Commit**

```bash
git add OLE.md README.md
git commit -m "docs: Ole fork notes and upstream merge routine"
```

---

### Task 2: Turn off auto-update

**Files:**
- Modify: `app/electron-builder.yml:6-10` (the `publish` block)
- Test: `app/test/builderConfig.test.ts` (extend)

**Interfaces:**
- Produces: packaged builds generate no `app-update.yml`, so `updatesOn(... feed: false ...)` at `src/main/index.ts:1102-1104` keeps updates off with no code change.

- [ ] **Step 1: Write the failing test** in `test/builderConfig.test.ts`:

```ts
it('Ole never publishes or checks a Yogurt release feed', () => {
  expect(config.publish).toBeNull();
});
```

(Use the file's existing loader for the YAML as `config`.)

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run test/builderConfig.test.ts`
Expected: FAIL, `publish` is the GitHub FrigadeHQ/yogurt object.

- [ ] **Step 3: Set `publish: null`** in `electron-builder.yml`, with a comment: Ole has no update feed in v1; never point this at FrigadeHQ/yogurt.

- [ ] **Step 4: Run it**

Run: `pnpm exec vitest run test/builderConfig.test.ts`
Expected: PASS (update any existing assertion in this file that pinned the GitHub publish block).

- [ ] **Step 5: Commit**

```bash
git add electron-builder.yml test/builderConfig.test.ts
git commit -m "chore(ole): turn off auto-update so Ole never pulls a Yogurt release"
```

---

### Task 3: Rename what users see and what collides

**Files:**
- Create: `app/src/shared/brand.ts`
- Test: `app/test/ole/brand.test.ts`
- Modify (seams): `app/src/shared/i18n.ts:102` (`t`), `app/src/main/paths.ts:6`, `app/src/main/index.ts:94,96,135`, `app/src/renderer/index.html:5`, `app/electron-builder.yml` (appId, productName, artifactName for mac, dmg title, `NS*UsageDescription` strings, `extraMetadata.name`), `app/package.json` (`productName`), `app/native/yogurt-audio/Info.plist`, `app/native/yogurt-mac/Info.plist`, `app/native/yogurt-mcp/Info.plist`, `app/native/yogurt-mcp/main.swift:10,31`, `app/src/shared/exportNotes.ts:131`, `app/resources/about/Credits.html`, `app/test/notificationPermission.test.ts`, `app/test/builderConfig.test.ts`, `app/scripts/release-mac.sh:78`

**Interfaces:**
- Produces:

```ts
// app/src/shared/brand.ts
export const PRODUCT_NAME = 'Ole';
export const APP_ID = 'net.cjett.ole';
export const DATA_FOLDER = 'Ole';
/** User-visible text with Yogurt's product name replaced; keys and internal names untouched. */
export function brand(text: string): string;
```

- [ ] **Step 1: Write the failing tests** in `test/ole/brand.test.ts`:

```ts
it('brand() swaps the product name in user text only', () => {
  expect(brand('Open Yogurt')).toBe('Open Ole');
  expect(brand('Quit Yogurt')).toBe('Quit Ole');
  expect(brand('yogurt-audio')).toBe('yogurt-audio'); // lowercase internal ids untouched
});
it('t() returns branded text for any locale', () => { /* setLanguage('en'); expect(t('Open Yogurt')).toBe('Open Ole') */ });
it('data folder is Ole, never Yogurt', () => { /* userDataDir() with YOGURT_USER_DATA unset ends with /Ole */ });
it('builder config identifies as Ole', () => {
  // appId === 'net.cjett.ole', productName === 'Ole', mac artifactName starts with 'Ole-'
});
it('helper bundle ids and the MCP helper path are Ole', () => {
  // read the three Info.plist files: CFBundleIdentifier === net.cjett.ole.audio-helper / .mac-helper / .mcp
  // read native/yogurt-mcp/main.swift: contains 'Application Support/Ole' and 'net.cjett.ole', not 'so.yogurt.app'
});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run test/ole/brand.test.ts`
Expected: FAIL, `brand.ts` does not exist.

- [ ] **Step 3: Implement `brand.ts`** (`brand` replaces the capitalised word `Yogurt` only, as a whole word) and apply it at the seams: wrap the return of `t` in `i18n.ts:102` with `brand(...)`; `paths.ts` uses `DATA_FOLDER`; `index.ts` uses `PRODUCT_NAME` for `setName` and the window title and `APP_ID` for `setAppUserModelId`; `index.html` title `Ole`; builder config, `package.json` productName, the three Info.plist ids and names, `yogurt-mcp/main.swift` path and `open -b` id; `exportNotes.ts` credit becomes `[Ole](https://github.com/FrigadeHQ/yogurt)`-free: write `Made with Ole (a fork of Yogurt)`; `Credits.html` adds "Ole is a fork of Yogurt by Frigade, MIT" above Yogurt's credits; `release-mac.sh` asserts `net.cjett.ole`. Update the two existing tests that pin Yogurt names to the Ole values.

- [ ] **Step 4: Run the brand tests and the whole suite**

Run: `pnpm exec vitest run test/ole/brand.test.ts && pnpm test && pnpm typecheck`
Expected: PASS, all files.

- [ ] **Step 5: Build and launch once by hand**

Run: `pnpm build && pnpm dev` (or the repo's documented dev command)
Expected: the tray and menu say "Open Ole" and "Quit Ole"; `~/Library/Application Support/Ole/` is created; nothing appears in `~/Library/Application Support/Yogurt/`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/brand.ts test/ole/brand.test.ts src/shared/i18n.ts src/main/paths.ts src/main/index.ts src/renderer/index.html electron-builder.yml package.json native/yogurt-audio/Info.plist native/yogurt-mac/Info.plist native/yogurt-mcp/Info.plist native/yogurt-mcp/main.swift src/shared/exportNotes.ts resources/about/Credits.html test/notificationPermission.test.ts test/builderConfig.test.ts scripts/release-mac.sh
git commit -m "feat(ole): rename user-visible branding and ids so Ole and Yogurt can coexist"
```

---

### Task 4: Encrypted key store

**Files:**
- Create: `app/src/main/ole/secrets.ts`, `app/test/ole/secrets.test.ts`
- Modify (seams): `app/src/main/settings.ts:6-52` (`Settings` type), `app/src/main/index.ts` (call `hookOleSecrets` next to `hookPreferences`), `app/src/preload/index.ts` (~line 251, `window.yogurt.ole`), `app/src/shared/types.ts` (type of `ole` on `YogurtApi`)

**Interfaces:**
- Produces:

```ts
// settings.ts gains:  oleSecrets?: Partial<Record<SecretName, string>>   // sealed values only
export type SecretName = 'openai' | 'siesta';
export function sealSecret(plain: string): string;            // 'k:' + base64 when safeStorage is available
export function openSecret(sealed: string): string | null;    // null when it cannot decrypt
export function readSecret(file: string, name: SecretName): string | null; // main process only
export function maskSecret(plain: string): string;            // first 3 + '…' + last 4, '' when empty
export function hookOleSecrets(d: { file: string }): void;
// IPC: 'ole:secret:set' (name, value: string; '' clears), 'ole:secret:status' -> Record<SecretName, { set: boolean; masked: string }>
```

- [ ] **Step 1: Write the failing tests** (mock `electron` with a reversible `safeStorage` and an `ipcMain.handle` map, as `test/updatesSwitch.test.ts` does):

```ts
it('stores keys sealed, never in plain text', () => { /* set('openai','sk-test-123456'); settings.json contains no 'sk-test' */ });
it('readSecret returns the plain key in the main process', () => {});
it('status is masked and never holds the key', () => { /* { openai: { set: true, masked: 'sk-…3456' } } */ });
it("settings:get never includes a sealed or plain key", () => {});
it('an empty value clears the key', () => {});
it('refuses to store when safeStorage is unavailable', () => { /* isEncryptionAvailable false -> throws, nothing written */ });
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run test/ole/secrets.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `secrets.ts`** using `safeStorage.encryptString`/`decryptString` and `updateSettings`; unlike Yogurt's calendar sealing, never fall back to a plain `b:` value. Wire `hookOleSecrets({ file: settingsFile })` in `index.ts` and expose `window.yogurt.ole.setSecret(name, value)` and `.secretStatus()` in the preload.

- [ ] **Step 4: Run them**

Run: `pnpm exec vitest run test/ole/secrets.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ole/secrets.ts test/ole/secrets.test.ts src/main/settings.ts src/main/index.ts src/preload/index.ts src/shared/types.ts
git commit -m "feat(ole): keys sealed with safeStorage, masked status, never sent to the renderer"
```

---

### Task 5: Provider settings and the Ole settings section

**Files:**
- Create: `app/src/main/ole/providers.ts`, `app/src/renderer/src/ole/OleSettings.tsx`, `app/test/ole/providers.test.ts`, `app/test/ole/oleSettings.test.ts`
- Modify (seams): `app/src/main/settings.ts` (`Settings`), `app/src/renderer/src/screens/Settings.tsx` (render `<OleSettings />` as a section next to `AiApps`), `app/src/preload/index.ts`, `app/src/shared/types.ts`, `app/src/main/index.ts` (call `hookOleProviders`)

**Interfaces:**
- Consumes: `readSecret`, `maskSecret`, `window.yogurt.ole.setSecret/secretStatus` (Task 4).
- Produces:

```ts
export type OleProviders = {
  transcription: 'local' | 'openai';   // default 'local'
  assistant: 'local' | 'openai';       // default 'local'
  openaiTranscribeModel: string;       // default 'gpt-4o-mini-transcribe'
  openaiChatModel: string;             // default 'gpt-5.6-luna'
};
export function providersOf(s: Settings): OleProviders;    // fills defaults
export function hookOleProviders(d: { file: string }): void;
// IPC: 'ole:providers:get' -> OleProviders, 'ole:providers:set' (patch: Partial<OleProviders>)
// Settings keys: oleTranscription, oleAssistant, oleTranscribeModel, oleChatModel
```

- [ ] **Step 1: Write the failing tests**

```ts
it('defaults to local for both and the documented OpenAI models', () => {
  expect(providersOf({})).toEqual({ transcription: 'local', assistant: 'local', openaiTranscribeModel: 'gpt-4o-mini-transcribe', openaiChatModel: 'gpt-5.6-luna' });
});
it('rejects unknown provider values', () => { /* set({ assistant: 'anthropic' }) leaves 'local' */ });
it('the settings section lists Anthropic and Vertex as coming later and offers only Local and OpenAI', () => {
  // renderToStaticMarkup(<OleSettings ... />): options 'Local', 'OpenAI'; text 'Anthropic and Vertex: coming later'
});
it('key fields show the masked value, never the key', () => {});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run test/ole/providers.test.ts test/ole/oleSettings.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement** `providers.ts` and `OleSettings.tsx` (Transcription and Assistant selects, OpenAI key and Siesta key password inputs with Save and Clear, model name inputs, all via `window.yogurt.ole`). Before setting the defaults, check them: with a real key, `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | jq -r '.data[].id' | grep -E 'transcribe|luna'`; if either default is not listed, use the closest listed model and note it in `OLE.md`.

- [ ] **Step 4: Run them**

Run: `pnpm exec vitest run test/ole/providers.test.ts test/ole/oleSettings.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ole/providers.ts src/renderer/src/ole/OleSettings.tsx test/ole/providers.test.ts test/ole/oleSettings.test.ts src/main/settings.ts src/renderer/src/screens/Settings.tsx src/preload/index.ts src/shared/types.ts src/main/index.ts OLE.md
git commit -m "feat(ole): provider selectors and keys in Settings (Local or OpenAI)"
```

---

### Task 6: OpenAI notes model

**Files:**
- Create: `app/src/main/ole/openaiModel.ts`, `app/test/ole/openaiModel.test.ts`
- Modify (seam): `app/src/main/index.ts:619` (choose the model) and the `modelReady` gate in the `createQueue` call just below it

**Interfaces:**
- Consumes: `readSecret(file, 'openai')` (Task 4), `providersOf` (Task 5), `Llm` type from `src/main/notes/enhance.ts:13`, the surface returned by `createNotesModel` (`llm(signal)`, `unload()`, `loaded`, `needsLoad`).
- Produces:

```ts
export function createOpenAIModel(o: {
  key: () => string | null;
  model: () => string;
  fetch?: typeof fetch;
  baseUrl?: string;            // default 'https://api.openai.com/v1'
}): ReturnType<typeof createNotesModel>;
// Llm.chat(prompt, onToken, opts) -> POST {baseUrl}/chat/completions with stream: true,
//   messages: [...(opts.before ?? []).map(content => ({ role: 'system', content })), { role: 'user', content: prompt }],
//   max_completion_tokens: opts.maxTokens; each SSE delta goes to onToken; resolves with the full text.
// count(texts) = Math.ceil(chars / 4); contextSize = 128000; loaded = true; needsLoad = false; unload resolves.
```

- [ ] **Step 1: Write the failing tests** with a fake `fetch` returning an SSE `ReadableStream`:

```ts
it('streams deltas to onToken and resolves with the whole answer', async () => {});
it('sends the key as a Bearer token and the configured model', async () => {});
it('a 401 rejects with "OpenAI rejected the API key" and never logs the key', async () => {});
it('no key rejects with "Add an OpenAI key in Settings"', async () => {});
it('an abort signal cancels the request', async () => {});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run test/ole/openaiModel.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** `createOpenAIModel`; at `index.ts:619` pick it when `providersOf(loadSettings(settingsFile)).assistant === 'openai'` (read per call through a small wrapper so a Settings change applies to the next job without a restart), else Yogurt's `createNotesModel`; make `modelReady` true when the assistant is OpenAI. Embeddings stay local.

- [ ] **Step 4: Run them and the suite**

Run: `pnpm exec vitest run test/ole/openaiModel.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ole/openaiModel.ts test/ole/openaiModel.test.ts src/main/index.ts
git commit -m "feat(ole): OpenAI as the notes model behind Yogurt's model surface"
```

---

### Task 7: OpenAI transcription (chunk-based)

**Files:**
- Create: `app/src/main/ole/openaiTranscribe.ts`, `app/test/ole/openaiTranscribe.test.ts`
- Modify (seam): `app/src/main/asr/index.ts:208-224` (`open()`: a branch next to `isFake()`), plus the `p.modelPath()` gates at about line 210 and 279

**Interfaces:**
- Consumes: `Transcribe`, `Line` from `src/main/asr/transcribe.ts`; `Chunk` from `src/main/asr/chunker.ts:9`; `wavBytes` from `transcribe.ts:17`; `readSecret`, `providersOf`.
- Produces:

```ts
export function createOpenAITranscriber(o: {
  key: () => string | null;
  model: () => string;
  fetch?: typeof fetch;
  baseUrl?: string;   // default 'https://api.openai.com/v1'
}): Transcribe;
// Final chunks: POST {baseUrl}/audio/transcriptions (multipart: file = wav of chunk.samples, model),
//   returns [{ track: chunk.track, startMs: chunk.startMs, endMs: chunk.startMs + duration, text }] or [] for empty text.
// Partial requests ({ partial: true }) return [] (no partials in v1; Apple Speech partials still show where available).
```

- [ ] **Step 1: Write the failing tests**

```ts
it('posts the chunk as WAV with the model and maps the text to a Line on the same track', async () => {});
it('times the line from the chunk start and its sample length at 16 kHz', async () => {});
it('empty text returns no lines', async () => {});
it('a 401 throws "OpenAI rejected the API key"', async () => {});
it('a network failure throws, and the next chunk still transcribes', async () => {});
it('partial requests return [] without a network call', async () => {});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run test/ole/openaiTranscribe.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** `createOpenAITranscriber`; in `asr/index.ts` `open()`, when `providersOf(...).transcription === 'openai'`, build the pipeline with it instead of the whisper transcriber, and skip the local-model gates so recording works with no local model installed. The pipeline's existing `onWarn` path reports a thrown chunk; do not add retries in v1.

- [ ] **Step 4: Run them and the suite**

Run: `pnpm exec vitest run test/ole/openaiTranscribe.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ole/openaiTranscribe.ts test/ole/openaiTranscribe.test.ts src/main/asr/index.ts
git commit -m "feat(ole): OpenAI transcription behind Yogurt's Transcribe seam"
```

---

### Task 8: End-to-end check and handoff to Plan 2

**Files:**
- Modify: `OLE.md` (what Plan 1 delivers, the seams list with file and line, manual test notes)

- [ ] **Step 1: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all exit 0.

- [ ] **Step 2: Manual call test on the Mac**: set both providers to OpenAI, add the key, start a test call (a meeting with yourself or a YouTube clip through a call app), confirm live lines appear as Me and Them with speaker names where the call app shows them, stop, and confirm the summary is written by OpenAI. Then clear the key and confirm recording still works and the summary shows the "Add an OpenAI key" error.

- [ ] **Step 3: Record the seams** in `OLE.md`: every Yogurt file Ole edits, with the line and why, so upstream merges know where conflicts can appear.

- [ ] **Step 4: Commit**

```bash
git add OLE.md
git commit -m "docs(ole): Plan 1 seams and manual test notes"
```
