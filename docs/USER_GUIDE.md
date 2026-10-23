# Interview Studio user guide

[Back to the project README](../README.md)

This reference describes the Electron/React interview workspace: live captions, translation, contextual Q&A, and conversation history.

## Live captions

After `npm run build`, `npm run test:floating-bar` checks real Electron minimize/restore and exit behavior with temporary app data, synthetic audio, generated screenshot attachments, and mocked text responses. It verifies continued captions and answers, preservation of drafts and screenshots, compact/maximized restore, on-top placement, and full exit from the bar or workspace. No real devices or hosted API calls are used.

The workspace opens directly to captions and answers. The narrow navigation rail holds New session, Interview chat, Conversation history, and Settings. Caption options holds input sources, filters, text size, and audio meters; the main controls keep Start/Pause, Stop, and Mute mic visible. Attach opens files and screen/window capture, while Select area stays beside the question input. Window options holds pinning, hide, and transparency; Compact remains in the header. Response style, profiles, jobs, and providers are configured in Settings.

In **Settings > AI connection > Caption transcription**, choose **OpenAI**, **OpenRouter**, or **Offline (local)**. This choice is saved independently of your chat provider. Cloud captions reuse the selected provider's saved key; you can also enter its key here while a different chat provider is active. The OpenRouter key is shared with its chat connection.

Open **Caption options** in Live captions to choose **Microphone + computer**, **Computer audio**, or **Microphone**, then click **Start captions**. Selected audio is processed only by your chosen caption provider; there is no automatic provider fallback.

Live captions open by default as the larger primary panel, with chat and question input in a narrower secondary panel. Smaller windows stack captions above chat. Opening the panel does not start audio capture. Uncased uppercase recognition text is shown in readable sentence case, preserving common acronyms; this same text is used for questions and exports.

- **YOU** is microphone audio. **Professional** is computer audio. These labels come from the capture source. There is no speaker identification, voice matching, or speaker renaming.
- Consecutive captions from the same source continue in one message, including across pauses and recognition segments. A source change starts a new message. Compact captions, filtered views, restored sessions, and exports use the same grouping; interim revisions still replace their original segments.
- Use **All**, **Professional**, or **YOU** in Caption options to filter the transcript. **Draft answer** on a Professional caption immediately sends that caption to your selected chat provider, with up to three nearby conversation turns and any context you explicitly added. It uses the selected profile and job while preserving your unfinished question and screenshot attachments. Highlight text within one caption paragraph to **Draft selection** instead. A translated selection uses the highlighted text; the default button uses the original caption.
- **Add as context** on YOU captions adds a snapshot to the question composer without sending a request. Expand **Caption context** to inspect or remove passages. The caption dropdown keeps **Edit before sending** and lets you add Professional speech as context. Context is bounded to six passages and 6,000 characters, labeled by source, and shown beneath the submitted question as **Conversation used**. Context used for an answer is retained in its saved question thread and explicit export.
- Caption options also offers **Draft latest question**. Enable its optional **Ctrl/Cmd + Shift + Enter** shortcut to draft the latest completed Professional passage while this app is focused; it is off by default, never runs in Settings or the library, and does not interrupt an answer already being generated. It does not detect questions automatically or send requests as captions arrive.
- **Pause** disables audio tracks, **Resume** enables them again, and **Stop** ends capture. New session, leaving chat, panic hide, closing the window, or reloading the renderer also stops capture. Collapsing the panel leaves captions running.
- **Mute mic** disables only microphone captions while computer captions continue. It discards pending microphone text and stays muted through Pause/Resume; **Unmute mic** enables microphone captions again. This also works before Start. Use it while listening through PC speakers, since speaker playback can enter the microphone and appear as YOU.
- Offline captions update incrementally during speech; developing text can change until the phrase is complete. Cloud captions arrive after a short pause or a bounded 12-second chunk, plus transcription latency. OpenAI uses `gpt-4o-transcribe` for both sources; OpenRouter uses `microsoft/mai-transcribe-2` with plain JSON transcription and no diarization options.
- Audio and pending batches stay in memory and are never saved to disk. Stop aborts pending requests. Caption text is saved locally and can be reopened from Conversation history or included in an explicit export with YOU/Professional labels.
- Computer-audio capture currently requires Windows and includes other apps. A headset helps keep computer playback out of your microphone. Nearby voices or echo can appear under YOU. Use captions with participants' permission.

See the [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) and [OpenRouter speech-to-text documentation](https://openrouter.ai/docs/guides/overview/multimodal/stt).

### Conversation history and question threads

Q&A answers are written to speak directly: plain text, easy words, normal punctuation, and short paragraphs. The prompt uses Topic, Intent, and key points to organize a clear opening and connected explanation without printing those labels. Behavioral answers use STAR when the supplied experience supports it; technical questions get a direct explanation and relevant tradeoffs. There are no coaching notes, extra tips, Markdown lists, or placeholders. Missing personal experience leads to an honest hypothetical approach rather than an invented story. In Settings, choose **Simple & professional**, **Concise structure** (a shorter spoken answer), or **Detailed answer**. Older saved hints/critique styles map to these speaking styles when reopened. Existing saved answers stay as they were; new answers and retries use the updated prompt.

Captions remain the main panel. **Draft answer** or a highlighted **Draft selection** creates a saved question in the Answers panel, linked to its caption passage. Selecting the same question again shows **View answers** and reopens its saved responses without another model request. The **Questions** menu switches between saved questions; new speech does not change your selection.

Failed or stopped questions show **Retry answer** instead of being treated as completed saved answers. Selecting the same caption text retries that question in place; different selections can still start a question after an error. The answer also offers **Retry answer** and **Edit question** controls. Error details appear separately from generated text, are saved/exported with the conversation, and are excluded from follow-up model context. A retry replaces that attempt, retaining its original question and context. Caption actions and retries preserve the composer draft and pending attachments. Streaming follows the latest answer until you scroll up, and answer text supports normal mouse selection and copying.

An immediate retry can reuse the latest request's screenshots in memory. Screenshot pixels are never saved to conversation history. After another answer or a restart, an older screenshot question offers **Edit & resend** so you can reattach the images explicitly. Retries use the currently selected AI connection and remain subject to its usage and credit limits.

Type in the composer while a question is selected to ask a follow-up in that question's thread. Requests include that question's bounded caption context and recent answers, plus a compact overview and relevant earlier speech from the same conversation. Other questions' generated answers are excluded. **New question** detaches the composer from the selected thread while keeping your unsent draft and attachments. **New session** starts a separate conversation and saves the previous one.

If Q&A stops because of credits, spending limits, a daily quota, or OpenRouter's in-flight credit budget, the app automatically tries other configured providers. It starts with your selected provider, then checks saved OpenAI, NanoGPT, OpenRouter, and explicitly saved LM Studio connections in that order, skipping the selected provider and missing credentials. Each provider uses its own saved model and receives the same question, context, profile and screenshots. The answer displays the actual provider and a switch notice; your preferred provider in Settings stays unchanged. A partial interrupted answer is kept separately under **Previous partial answer**, while the replacement starts fresh. These details are saved and exported. No configured alternative produces a clear Settings message; exhausting alternatives lists the providers tried. Stop cancels the whole chain, which shares one request deadline. Ordinary authentication, model, network or temporary rate-limit errors do not start fallback; once credit recovery has begun, unavailable alternatives are skipped in turn. Provider charges still apply. [Official OpenAI error documentation](https://developers.openai.com/api/docs/guides/error-codes) distinguishes billing/quota errors from temporary throttling. Caption transcription and translation keep their separate provider rules.

Text changes are coalesced for automatic saving after about one second, increasing to five seconds once a conversation has 500 caption segments or 50 question threads. Revisions arriving during a disk write wait for the next periodic batch, and acknowledged unchanged text is not rewritten just because the UI rendered. Conversation switches and normal exit immediately flush the latest draft and partial answer. Files still use atomic JSON replacement; the five-second interval bounds repeated whole-file writes in long sessions. Startup opens a new, empty session without starting audio capture or making a model request. Previous conversations remain available in **Conversation history** and open only when selected. An empty startup session does not create a history entry or overwrite older conversations. An interrupted answer is marked stopped when its conversation is reopened. Capture IDs are scoped to each recording so resuming captions cannot overwrite earlier speech.

### Memory across a long interview

A local index uses finalized original captions to maintain up to eight diverse speech excerpts across the conversation timeline. **Caption options > Conversation summary** lets you inspect this running extractive summary. It selects original speech rather than generating new claims, and does not call a model, download embeddings, or require another API key. Developing recognition updates are indexed at most once every two seconds in the background; asking a question synchronously catches up with the latest captions.

For each question, local keyword retrieval also selects up to six relevant earlier speech passages, including ones from hours earlier that are absent from the overview. Retrieval uses term rarity, a small technical alias vocabulary, and CJK character pairs. It is lexical retrieval, so paraphrases without shared terms can be missed. All speech remains saved even when it is outside the selected context. Original source labels and elapsed timestamps accompany the excerpts; recognition errors remain possible. AI-generated answers and translations are not indexed as facts about the candidate.

The API history portion remains at most **24,000 characters**, shared between nearby selected context, the overview (2,800), relevant earlier speech (6,000), the selected root question (2,000), and up to six recent exchanges from that question's thread (6,000). The current user question and profile/resume/job instructions have their existing separate limits. This controls history input size; it does not guarantee a token count or that every provider/model accepts the entire request. Summaries and retrieval make no extra API calls. Hosted Q&A receives the chosen excerpts only when the user sends a question, in addition to their selected question context and configured profile. Hosted captions and translation retain their separate processing and usage.

Each answer saves its exact **Interview summary used** and **Earlier speech used** excerpts, available as collapsed details in Answers and included in export. The index is rebuilt from captions on reopen, and New session starts with empty memory. Old history files remain readable. Captions retain the four-hour session expiration, so a three-hour interview is within the configured time limit.

`npx vitest run tests/long-interview.test.ts` advances a caption session through three hours and the four-hour expiry using a simulated clock, then processes 10,800 synthetic caption segments and 180 questions with real atomic save/reopen checkpoints. After compiling, `npm run test:long-interview` opens a comparable three-hour dataset in Electron, checks recall of a minute-two fact, follow-up context, restart, export, conversation isolation, and narrow/compact layouts with mocked provider responses. **These are accelerated workload tests, not a continuous three-hour audio/translation/device soak.** They cannot establish uninterrupted real-world provider, microphone, computer-audio, or thermal stability.

**Conversation history** searches titles, original captions, saved translations, questions, and answers. Each conversation supports rename, export, and confirmed delete. Export includes the full transcript and all question threads, not just the currently displayed answer. Files exceeding the 64 MB export limit produce an error rather than a truncated export. Previously saved translations can be viewed by selecting their target language while capture is off; this does not start translation requests.

History is stored as plaintext JSON under the Electron user-data directory's `conversations` folder (normally `%APPDATA%/interview-studio/conversations`). It contains text and screenshot reference names, never recorded audio, screenshot pixels, or API keys. API keys remain in their separate encrypted settings storage where supported. Writes replace files atomically; unreadable files are preserved and reported. Delete removes only the selected conversation file, preserving settings, models, and other conversations. Unsaved drafts and screenshots from older app versions cannot be recovered after those versions exit.

After `npm run build`, run `npm run test:history` to exercise four independent Electron launches with isolated app data, synthetic audio, and mocked providers. It checks automatic save, close flushing, restored translations and question threads, follow-up context, repeated recognizer IDs, search, rename, full export, deletion across restarts, and narrow/compact layouts. It uses no recording devices or hosted APIs.

`npm run test:history-failures` adds five isolated Electron launches covering startup-read retry, corrupt-file warnings, simulated disk-full and delete-permission errors, export during a save failure, partial answers after cancellation or provider disconnect, erased drafts across restarts, and a larger Unicode history with 220 caption turns and 80 saved questions. The disk-full fixture verifies that failed saving pauses exit and leaves the previous file intact. These injected errors are expected test output; the fixture never changes the user's app data or calls hosted providers.

`npm run test:question-recovery` exercises repeated HTTP and streaming failures, the same/different caption selections after errors, explicit retry, cancellation, follow-up context, screenshot reuse, answer copying/text selection, duplicate-click protection, composer preservation, compact controls, and retry after reopening history. Both Electron launches use synthetic provider responses and isolated app data.

`npm run test:ui-audit` checks 28 compiled-desktop scenarios covering keyboard dropdown navigation, provider and translation save/test feedback, encrypted key handling, proxy validation, profiles and TXT/Markdown/PDF resumes, job editing and delayed company-research recovery, normal/narrow settings layouts, window controls, a real duplicate-process launch, eight-source screenshot attachment, cropped area selection and cursor behavior, caption filters and mute, and saved translation reading views. It uses generated files/screenshots, simulated hosted responses, and a disposable profile; it never uses real recording devices or accounts. It saves a JSON result and settings screenshots in the temporary profile printed on completion.

`npm run test:provider-fallback` runs isolated desktop scenarios for exhausted/in-flight credits, saved-provider/model selection, OpenAI billing failures over HTTP and SSE, local LM Studio, missing alternatives, failed alternatives, cancellation, profile/image preservation, partial-answer separation, and reopening saved results. All provider responses are fixtures; no real accounts are contacted.

### Offline translation packs

Select **Settings → AI connection → Caption translation → Offline (language packs)**. Search for a target language and download only its pack, or choose it in the live caption **Translate** menu and use the download button above the captions. Download size, progress, cancellation, retry, installed state, and removal are available. Selecting a language never starts a download automatically.

This version translates **English captions into 30 target languages** using official Argos packs and a native CTranslate2 CPU engine. English itself needs no pack. Tamil and Telugu currently have no supported offline pack and remain available through online providers. Packs are directional; other source languages are not auto-detected by this offline engine. Also select Offline under Caption transcription to keep both recognition and translation local. Installed packs require no internet, API key, Python installation, or LM Studio.

Each pack downloads approximately 65–196 MB; installed size differs. Only one translation model is loaded at a time, using two CPU threads in an isolated utility process. Long passages are split into bounded sentence-sized pieces. Offline translation waits for a sentence ending, a finalized passage, or 0.8 seconds of unchanged text to provide more context. Continuous revisions are buffered for at most 2.5 seconds before becoming eligible for the next request; inference and queued work add further latency. Original captions remain immediate. Latency and quality depend on language and hardware; older packs can produce awkward wording. Short Spanish and Korean sample translations on this PC took roughly 0.4–0.9 seconds after loading. This is a sample measurement, not a guarantee for every language or continuous two-source workload.

Packs are stored in the app data directory under `translation-packs/en-<language>`. Downloads are checked against their fixed byte size and publisher archive checksum. Only model, tokenizer, metadata, and attribution data is installed. File SHA-256 hashes are recorded at installation and checked before model loading. Removing a pack preserves original captions and chat history. There is no automatic online fallback.

### HTTP cache recovery

Interview Studio disables Chromium's HTTP disk cache and asks Electron to clear only its HTTP cache at startup, before opening the UI or making provider requests. This avoids reusing damaged cached responses. Startup waits at most three seconds for cleanup; a failed or stalled reset does not prevent the app from opening, and HTTP disk caching remains disabled. This does not clear cookies, local storage, conversation history, settings, encrypted API keys, or downloaded caption/translation models. No app-data folders are deleted.

After `npm run build`, run `npm run test:cache` for the Electron cache safety check. It uses temporary generated app data and a localhost server to verify normal startup, a simulated cache-reset failure, fresh HTTP responses, and preservation of settings, an encrypted fixture key, model files, cookies, local storage, and IndexedDB. No real credentials, recording devices, or hosted API calls are used.

### Live translation

If a provider declines a caption passage through its content filter, that passage keeps its original text with a small **Translation skipped for this passage** notice. Translation continues for both audio sources and later passages without a Retry click. The declined passage and its recognition revisions are not automatically resubmitted; changing the translation language or provider creates a new translation configuration. Session exports preserve the skipped marker.

The retry icon beside a skipped passage retries **only that passage**, once with your selected translation provider. If that attempt fails or is declined again, it tries the installed offline English-to-target language pack. The provider and model in Settings stay unchanged. A spinner shows the active retry; success replaces the skipped marker, with **Offline · English source** identifying a local result. Failed retries show an explanation beside the original passage and leave later caption translations running. Explicit passage retries also work on saved history with captions off; they never start audio capture. They can incur another hosted translation request.

Offline fallback requires an installed, supported target pack and English source text. Clearly incompatible writing systems are rejected, but the app does not reliably detect the source language of Latin-script text. Missing or damaged packs show a **Download pack** action with the download size; downloads require that click and never start automatically. After installation, click the retry icon again. Tamil and Telugu have no offline packs. If both translation attempts fail, the original and skipped marker remain available for another retry. Stop, navigation, new/open conversation, target/provider changes, panic hide, and exit cancel active retries; late results cannot replace changed caption text. Successful translations and their offline origin are saved and exported with the conversation.

After compiling, `npm run test:translation-retry` checks the icon, pending state, selected-provider retry, missing/unsupported packs, cancellation, and restart persistence in Electron. Hosted responses are mocked and no recording devices are accessed. If the PC already has a Korean pack installed in the normal app-data directory, the test copies it into isolated temporary app data and exercises the actual native offline engine; it does not modify the user's pack or download one.

Click **Translate** beside the caption controls and search or select one of 33 target languages. Translation starts off by default. **Original + translation** pairs each original passage with its translation underneath, keeping one Professional/YOU header per speaking turn. **Translation only** emphasizes the target language and retains the original as a fallback until a translation is available. Right-to-left languages use their natural reading direction. Captions remain available when translation is disabled or fails.

Configure **Settings ? AI connection ? Caption translation** before enabling Translate. Choose **Azure Translator** (the default), **Google Cloud Translation**, **OpenRouter**, **OpenAI**, or **NanoGPT** independently of transcription and chat. Each has its own translation key. OpenRouter, OpenAI, and NanoGPT also have a separate editable **Translation model** field; changing it leaves your Q&A chat model unchanged. **Use chat connection** reuses the current chat credentials and model instead. Paste a translation API key and save; enter the Azure resource region from its Keys and Endpoint page, leaving it blank only for a global resource that does not require it. Keys are encrypted with operating-system storage, or retained only until exit if encryption is unavailable. A blank key keeps the existing key; **Remove key** deletes it. **Test connection** translates a short built-in sample. When you have edited a key, model, or region, **Save & test connection** saves those edits first, then tests them. Progress and success/error feedback appear beside the buttons. You can also save without testing. Each API keeps its own key when switching providers.

Azure uses Translator v3; Google uses Cloud Translation Basic v2 with standard NMT and automatic source-language detection. Select Azure?s **F0** resource tier to use its free allowance. Google offers a free allowance but can bill excess usage. The app cannot detect your billing plan or account-wide remaining quota. Revisions of developing captions count as additional translation input. See [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/translator/) and [Google pricing](https://cloud.google.com/products/translate/pricing) for current terms. Quota errors stop translation and keep original captions running; the app never switches to a paid provider automatically.

**Use chat connection** retains the previous translation path through the selected OpenAI, OpenRouter, NanoGPT, or LM Studio model. Hosted providers receive caption text and can charge for usage; no extra audio upload is made for translation. Offline English recognition stays local, but enabling hosted translation sends recognized text to that provider. To keep translation on your own server, choose Use chat connection with LM Studio and load a model capable of your target language. Translation quality and latency depend on the provider and language pair.

Enabling or changing the target language translates the two most recent passages from each source, then follows new speech. Developing passages are coalesced, with at most one active request per source and no more than one start per 1.5 seconds per source. Completed translations are reused within the same language and translation configuration; a language or provider switch discards late results from the previous selection. Stop, session reset, and panic-hide cancel pending work. Translation errors offer a separate Retry action and do not stop original captions. Already translated passages are saved in Conversation history and included in an explicit export. New app launches start with translation off; choosing a language with capture off displays saved translations without new requests.

### Offline caption setup

Choose **Offline (local)**, then **Download models (about 81 MB)**. Setup downloads six pinned English recognition and punctuation files (80.3 MB total), verifies their sizes and SHA-256 checksums, and stores them in the app's user-data directory under `caption-models/english-v1`. Progress, cancellation, and retry are available. Nothing downloads until you click setup. Existing verified recognition files are reused: upgrading an older installation downloads only the two punctuation files (7.6 MB). Speaker models from older installs are no longer required, checked, or loaded.

Once setup is complete, captions need no API key or internet. The same int8 English Zipformer model, beam-search decoder, and continuous 512 ms batches serve both sources. A persistent recognizer for each source preserves context; complete words retain their timestamps. Models load before capture starts. Stop kills the isolated native inference process.

The local Edge-Punct-Casing model restores commas, periods, question marks, and sentence casing as text develops. Its output is checked to preserve every recognized word; repeated unchanged text is cached. A sentence-ending mark is committed at an utterance endpoint or when capture stops, so unfinished live text does not get a premature full stop. Punctuation predictions can revise as more context arrives and are not guaranteed to be grammatically perfect. Both YOU and Professional use the same punctuation model, with no cloud requests.

Offline microphone and computer captions require sustained speech evidence from a small bundled WebRTC voice-activity detector. Silence, clicks, and very quiet noise do not authorize recognized words. Both sources retain continuous audio timing for recognition and sentence finalization, while words outside detected speech are suppressed. The detector runs locally and needs no additional model download. It detects speech, not identity: audible PC speaker playback reaching the microphone can still qualify as speech. Echo cancellation and noise suppression are requested for the microphone; use Mute mic while listening through speakers, or a headset to help separate playback from your voice.

This pack supports **English** on the **CPU**. Performance depends on your hardware. Computer loopback disables echo cancellation, noise suppression, and automatic gain to preserve playback; microphone processing stays enabled. Your selected chat provider is unchanged and can still need internet.

Upstream: [English Zipformer](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html), [English punctuation](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html#sherpa-onnx-online-punct-en-2024-08-06), and [sherpa-onnx Node addon](https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html).

After `npm run build`, run `npm run test:offline -- --models <model-directory> --audio <spoken-WAV-fixture>` for actual native inference checks of both sources, equal recognition quality, interim text, endpoint finalization, and pause/resume clocks. It performs no downloads or device recording. Use a clear spoken fixture at least three seconds long. Ordinary `npm test` covers routing, caption revisions, audio continuity, installation integrity, cancellation, and source separation without model downloads.

## OpenRouter setup

In Settings > AI connection, choose **OpenRouter API**, enter your OpenRouter API key, and save. The default base URL is `https://openrouter.ai/api/v1` and the default model is `openai/gpt-4.1-mini`; enter another OpenRouter model ID to change it. Choose a model with image input support when attaching screenshots. **Test connection** checks the API key and retrieves the model list without generating a paid answer.

If OpenRouter rejects a Q&A request with HTTP 402 and explicitly quotes a smaller affordable output-token budget, the app retries once with 10% headroom below that budget (minimum 512 output tokens). This within-provider retry keeps the question, conversation context, screenshots and model unchanged, and happens only before streaming starts. If credits are still insufficient, the saved-provider fallback described above applies, or a clear configuration/credit message appears. Account and key spending limits still apply.

Keys use operating-system encryption when available, otherwise they remain in memory until exit. Optional launch-time overrides are `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. OpenRouter requests follow the selected proxy route and its account/provider terms. See the [OpenRouter authentication guide](https://openrouter.ai/docs/api_reference/authentication).

## Permission model

Chat answers require no consent flow — you type a question and get an answer. Screenshots are attached only through an explicit action:

1. **Screens / windows:** choose several one-time screen/window thumbnails in the app and confirm which ones to attach.
2. **Attach files or drag and drop:** select or drop multiple screenshot files (PNG, JPEG, or WebP). Images are downscaled and kept in memory.
3. **Select area:** the app briefly hides while one-time snapshots appear over the displays. Drag on a display and release to attach that region. Esc, right-click, Cancel, or the panic-hide hotkey cancels selection. Each area is selected within one display; repeat to attach areas from other displays. Only the crop is added to the question; the complete display snapshots are discarded when selection closes.

The composer previews pending screenshots and lets you remove any of them. All remaining attachments are sent together with the next question and then detached. There is no app-imposed attachment count or combined payload limit; each image is validated and size-limited, and the selected provider may enforce its own request limits. Screenshots are never saved to disk by these attachment actions.

Screen and area capture use a short-lived, owner-bound grant consumed by that single request. Area overlays have their own restricted IPC endpoints and cannot access the main window's settings or coaching APIs. Screenshots are not recorded continuously.

If the interviewer, employer, or platform forbids AI assistance, do not use the app.

## Run locally

Requirements: Node.js 22+, npm, and Windows 10/11.

```powershell
npm install
npm run dev
```

Open **Settings** to enter your own API key manually. When OS-backed secure storage is available, the main process encrypts the saved key. If secure storage is unavailable, the key remains in memory only until the app closes. For development, `OPENAI_API_KEY` may instead be supplied in the launch environment. A manual key selected in Settings takes precedence; removing it falls back to `OPENAI_API_KEY` when that variable exists. Never commit a real key or place one in a checked-in environment file.

The same panel lets the user choose one of the recommended coaching models. A valid `OPENAI_MODEL` value supplied at launch takes precedence over the saved selection; remove the environment override and restart the app to use the Settings selection again. Chat answers use the selected coaching model through the Responses API.

### Proxy settings

The connection panel provides four network modes:

- **System:** use the operating system's proxy configuration.
- **Direct:** connect without a proxy.
- **HTTP:** send OpenAI HTTPS requests through a user-specified HTTP proxy. HTTPS remains protected end to end unless the device explicitly trusts a proxy certificate that performs TLS inspection.
- **SOCKS5:** send supported OpenAI TCP/HTTPS requests through an unauthenticated SOCKS5 proxy.

HTTP proxy username and password fields are optional. The app keeps these credentials in the main process and encrypts saved credentials with Electron `safeStorage` when OS-backed encryption is available. Without secure storage, proxy credentials are kept only in memory for the current app run. Chromium does not support SOCKS5 username/password authentication, so authenticated SOCKS5 proxies are not accepted.

The configured mode applies through Electron's Chromium network session to the OpenAI HTTPS traffic used by chat answers. It is a connectivity setting for networks on which the user is authorized to use that proxy. It is not an anonymity feature, an access-control bypass, or a way to evade employer, platform, proctoring, or network policy.

Use the connection test to verify API reachability through the configured route.

Useful commands:

```powershell
npm run typecheck
npm test
npm run build
npm run package
npm run dist:win
```

`npm run package` creates an unpacked application. `npm run dist:win` creates an NSIS installer under `release/`. Development artifacts are unsigned; broadly distributed builds should be reproducible and code-signed.

## Architecture and renderer trust

```text
React renderer
  |-- chat composer, answer panel, and capture UI
  `-- allowlisted IPC calls
          |
Electron preload (context bridge only)
          |
Electron main process
  |-- renderer and main-frame validation
  |-- owner-bound capture grants
  |-- BYOK, provider, model, and proxy settings
  |-- OS-encrypted API key and HTTP proxy credentials when available
  |-- Chromium-session routing for provider HTTPS/API traffic
  |-- one-shot source thumbnails and explicit export
  `-- OpenAI Responses API and OpenAI-compatible chat/completions requests (NanoGPT, OpenRouter, LM Studio)
```

The renderer is treated as untrusted: Node.js integration is disabled, context isolation and Chromium sandboxing are enabled, and privileged work stays in the main process.

In a packaged build, privileged IPC is accepted only from the application's exact local renderer entry file; query strings and fragments do not broaden that file boundary. In development, `ELECTRON_RENDERER_URL` must be an HTTP loopback URL, and IPC is accepted only from the configured development origin and pathname. In both cases, the sender must be the main frame of the app's own `BrowserWindow`. Navigation outside the trusted renderer is blocked, webviews are blocked, and new windows are denied.

## Data handling

- The long-lived API key is never returned to the renderer after submission. When `safeStorage` is unavailable, an entered key remains in process memory only.
- The HTTP proxy password is never returned to the renderer after submission. The username is returned so Settings can display and edit it. Both are encrypted together with `safeStorage` when OS-backed encryption is available and otherwise remain in memory only. SOCKS5 credentials are unsupported and are not stored.
- Proxy mode, host, port, and the selected coaching model are local application settings. A launch-time `OPENAI_MODEL` value overrides the saved model without exposing or replacing it.
- Your profile text (Settings → Coach profile) is sent only with chat requests and is presented to the model as untrusted content, never as instructions. Saved profiles (details, resume text, job description, and the active profile's company briefing) are stored locally in `settings.json` and are sent only with requests while that profile is active.
- Company analysis fetches only the profile's company website (https only) and public search results; that material is labeled as untrusted content, and the resulting briefing is saved into the profile on this device.
- Captions, translations, questions, answers, and unsent text drafts are saved locally as plaintext conversation files across restarts. Manage or delete them in Conversation history. Audio and screenshot pixels are not saved in history.
- Source selection and area capture take one-time snapshots in memory. Unselected images and display snapshots are released when selection closes. All selected screenshots are sent with the next chat request and then detached. File attachments and area crops are downscaled, kept in memory, and never written to disk by the app. New attachments added during an answer remain available for the next question.
- Chat requests use `store: false`; provider-side processing and retention remain subject to the configured OpenAI project's terms and settings.
- **Exports are plaintext.** When the user chooses Export, the app opens a native save dialog and writes UTF-8 Markdown or text to the path the user selects. Exports are not encrypted by Interview Studio and remain on disk until the user protects or deletes them.
- Profile text, questions, and screenshot text are treated as untrusted content in model prompts to reduce prompt-injection risk.

Do not include API keys, transcripts, screenshots, audio, exported files, or other personal information in bug reports.

## Project layout

```text
electron/main/      Window lifecycle, trust checks, grants, storage, export, OpenAI calls
electron/preload/   Typed, allowlisted renderer bridge
shared/             IPC contracts and mode-specific prompt construction
src/                React renderer (chat UI)
tests/              Security, prompt, and product-boundary regressions
```

## Current limitations

- Chat answers come from the selected provider and model (a built-in demo response appears when no key is configured for an active hosted provider). NanoGPT, OpenRouter, and LM Studio support chat and company analysis. Optional captions independently use OpenAI, OpenRouter, or the installed offline models.
- Screen references are user-selected still images, not continuous screen sampling.
- No account system, billing, cloud sync, auto-updater, or analytics. Conversation history uses local JSON files, without a database service.
- The local BYOK architecture is not suitable for a provider-funded subscription credential. Any future shared-credential service requires an authenticated backend, short-lived client credentials, quotas, and server-side spend and abuse controls.
- Model availability and charges depend on the user's OpenAI project. Recommended model choices do not guarantee that a particular project can access every listed model.
- HTTP and SOCKS5 settings cover OpenAI HTTPS/API traffic handled by Electron's network session.
- Interview-assistance and recording rules vary by employer, platform, and jurisdiction. Users remain responsible for lawful, permitted use.

