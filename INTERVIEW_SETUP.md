# Interview Copilot Setup — Session Notes (2026-09-17)

Context for a real, time-pressured session: get OpenCluely working live for a
recruiter interview conducted in English over Google Meet, where the AI should
transcribe the recruiter's spoken questions and generate an answer
automatically, without the candidate typing anything.

## What was broken and why

1. **Local Whisper model was never downloaded.** Every transcription attempt
   tried to lazy-download the model from `openaipublic.azureedge.net` with no
   timeout on the request. One of that CDN's two Azure Front Door edge IPs
   (`150.171.110.39`) is unreachable from this network (connection reset /
   timeout, reproduced with `curl`); the other (`150.171.110.40`) works. DNS
   round-robins between the two, so roughly half of attempts hung indefinitely
   — this is what looked like "the system stops responding."
   - Fix: downloaded `small.pt` and `base.pt` manually via the working IP,
     verified SHA-256 against the hash embedded in the model URL, and placed
     them in the directory the packaged app actually reads
     (`~/Library/Application Support/opencluely/.whisper-models/`, not the
     repo-local `.whisper-models/`, which is only used when
     `WHISPER_MODEL_DIR` is an **absolute** path).

2. **OpenCluely only ever listened to the physical microphone.** It has no
   loopback/system-audio capture, so it could never hear the recruiter's side
   of the call — only whatever bounced back into the mic acoustically, which
   `echoCancellation: true` in the capture constraints then actively
   suppressed (it treats system-audio-through-the-mic as an echo to cancel).
   - Fix: routed system audio through a loopback device so the recruiter's
     voice is what the OS "microphone" carries. See **Audio routing** below.
   - Also disabled `echoCancellation` / `noiseSuppression` / `autoGainControl`
     in `src/ui/main-window.js` (`_startRendererAudioCapture`) — those are
     tuned for a close-talk mic and fight a loopback signal; Whisper also
     transcribes raw audio better than processed audio.

3. **The transcription pipeline only had a "DSA" (strict, code-only) prompt.**
   `prompt-loader.js` hard-filtered out every skill except `dsa`, and the
   voice/transcription path (`llm.service.js#getIntelligentTranscriptionPrompt`)
   ignored the skill's actual prompt file anyway — it used its own generic,
   DSA-flavored wrapper regardless of which skill was active. A conceptual
   question ("what's the time complexity of binary search") got answered with
   "please provide the specific algorithmic problem..." because the model was
   told it's always in "DSA mode, output code only."
   - Fix: added a real conversational branch in `getIntelligentTranscriptionPrompt`
     for a new `interview` skill — answers directly, first person, no code
     unless asked, ~80-180 words. Added `prompts/interview.md` (used by the
     screenshot/OCR path), removed the `dsa`-only filter in
     `prompt-loader.js`, made `interview` the default active skill in
     `main.js`, and added it to `availableSkills` so `Cmd+Up`/`Cmd+Down` (while
     in interactive mode, `Alt+A` or `Cmd+Shift+I`) toggles between
     `interview` and `dsa` if a live-coding round comes up mid-call.

4. **A retired Gemini model in the fallback chain wasted retries.**
   `gemini-2.5-flash-lite` returns a permanent HTTP 404 ("no longer available
   to new users"), but the retry loop only treated 503/rate-limit as
   "skip to next model immediately" — a 404 got retried 3 times (with
   backoff) before giving up, then the next fallback also hit a transient 503.
   One question took **67 seconds** to answer because of this.
   - Fix: swapped `gemini-2.5-flash-lite` → `gemini-3.5-flash-lite` in
     `src/core/config.js`, and made the retry logic in
     `llm.service.js` (`executeRequest` and `executeStreamingRequest`) treat
     404 / `NOT_FOUND` / "no longer available" the same as an unavailable
     model — skip to the next fallback on the first failure instead of
     burning all retry attempts.

## Audio routing (macOS)

- **BlackHole 2ch** installed via `brew install blackhole-2ch` (needs
  `sudo killall coreaudiod` once after install to register).
- **Multi-Output Device** ("Dispositivo com Saída Múltipla") created via
  Audio MIDI Setup (GUI) combining Built-in Speakers + BlackHole 2ch. A
  hand-rolled `AudioHardwareCreateAggregateDevice` script was tried first and
  did **not** fan audio out to the second sub-device in three attempts — the
  GUI-created device works correctly (verified: play a tone/TTS through it,
  record from BlackHole with `ffmpeg -f avfoundation`, confirm non-silent
  audio with `volumedetect`).
- **System default output** = the Multi-Output device; **system default
  input** = BlackHole 2ch. OpenCluely reads whatever the OS reports as the
  default input device (`getUserMedia()` with no explicit `deviceId`), so this
  is what makes it "hear" the Meet call's remote audio.
- **Critical:** inside the meeting app itself (Zoom/Meet/Teams), the
  **microphone must be explicitly set to the physical mic** ("Microfone
  (MacBook Pro)"), not "Default" — since system default input is now
  BlackHole, an app that just follows system default would send silence (or
  its own remote audio looped back) instead of the candidate's voice.
  Output/speaker in the meeting app can stay on system default.
- **Revert after the call:**
  `SwitchAudioSource -s "Microfone (MacBook Pro)" -t input` (and reset output
  the same way) — otherwise every other app on the Mac keeps reading BlackHole
  as its mic.

## Current tuning

| Setting | Value | File |
|---|---|---|
| Whisper model | `base` (was `small`) | `.env` `WHISPER_MODEL` |
| Whisper language | `en` | `.env` `WHISPER_LANGUAGE` |
| VAD silence hangover | `400ms` | `.env` `WHISPER_SILENCE_HANGOVER_MS` |
| Utterance coalesce debounce | `300ms` | `main.js` `_utteranceCoalesceMs` |
| Whisper worker idle unload | `600000ms` (10 minutes) | `.env` `WHISPER_GPU_IDLE_MS` |
| Interview response | Usually 2-3 short sentences (30-60 words); 320 output token cap | `llm.service.js`, `prompts/interview.md` |
| Active skill default | `interview` (was `dsa`) | `main.js` constructor |
| Gemini fallback chain | `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite` → `gemini-3.5-flash` | `src/core/config.js` |

Earlier measurements on TTS-simulated questions through a Meet call found
~285ms Whisper (base model) and ~2.5-3.7s Gemini response. The shorter VAD and
coalescing waits above have not yet been timed on a live call. Transcription
accuracy held up (word-for-word) on the earlier tests at both `small` and `base`.

**Trade-off to watch:** `base` is ~3x faster to transcribe than `small` but
less accurate on accents / background noise / uncommon terms. All tests so
far used clean synthesized TTS through a clean digital loopback (best case).
If real-world transcripts start coming back garbled or missing words during
actual recruiter calls, switch back:
`WHISPER_MODEL=small` in `.env`, restart the app.

## Known limitations

- OpenCluely hears **only the remote side** of the call (via the BlackHole
  loopback) — never the candidate's own voice. That's intentional for "answer
  when she asks," but means this setup can't also transcribe things the
  candidate says out loud to themselves.
- `setContentProtection(true)` (the stealth/invisible-overlay feature) only
  works on macOS and Windows — no protection on Linux.
- Gemini's own transient 503 "high demand" errors are outside our control;
  the fallback chain now recovers from them faster, but can't eliminate the
  occasional multi-second wait entirely.
- Whisper model unloads after 10 minutes idle (`WHISPER_GPU_IDLE_MS`) and
  reloads cold on the next segment (~8s reload cost observed once). Keeping
  it loaded longer uses memory between questions.

## Personalized answers (done)

`interview` mode now answers using the candidate's real background instead of
generic textbook answers. Implemented as **context injection**, not
fine-tuning — fine-tuning a hosted Gemini model would need a training
pipeline and a dataset and takes far longer than useful here; a few
paragraphs of real background in the system prompt achieve the same
practical result instantly, for free.

- `candidate-profile.md` (extracted from the candidate's CV PDF) and
  `job-description.md` (the target role — Senior Front End Developer,
  Flutter-heavy) live at the repo root and are **gitignored** — they contain
  personal/employer information that must never be committed.
- `LLMService._loadInterviewContext()` (`src/services/llm.service.js`) reads
  both files once, caches them, and appends them to the `interview` system
  prompt built by `getIntelligentTranscriptionPrompt()`. Missing files fail
  silently (interview mode just falls back to generic answers) — no new
  required dependency.
- The CV/JD text only ever leaves the machine as part of the same Gemini API
  call already being made for every question — no new third party in the
  trust boundary.
- Verified live: a "tell me about a challenging Flutter project" question
  answered in 1.8s referencing real employers/projects instead of a made-up
  anecdote.
- **To refresh:** edit `candidate-profile.md` / `job-description.md` directly
  and restart the app (the cache is per-process). To reuse for a different
  interview, just swap `job-description.md`'s content.

## Dart support added

The "dsa" skill can now force **Dart** as the implementation language (in
addition to C++, C, Python, Java, JavaScript) — added to the language
dropdown in both `index.html` and `settings.html`. While doing this, the
three previously-duplicated language/fence-tag maps
(`prompt-loader.js`, `llm.service.js` ×2) were consolidated into a single
source of truth at `src/core/languages.js` (`getLanguageTitle`,
`getLanguageFence`) — adding the next language is now a one-line change in
one file instead of four. Verified live: a "reverse a singly linked list"
question with skill=dsa, language=dart returned a full solution with
`programmingLanguage: "dart"` in the response metadata.

## Status: ready

Everything above has been implemented and verified live against the actual
Google Meet call: audio capture, transcription, fast failover, personalized
conversational answers, and Dart code-mode. No open action items from this
session.
