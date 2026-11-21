# Managed Laptop Validation

This checklist is for the target Windows device and the organization's approved test process. Automated diagnostics do not request browser permissions, approve backend actions, or establish policy compliance. Do not enter provider secrets in the browser. Keep the page open during browser voice tests.

Record each result in **Managed Device Validation** using `PASS`, `FAIL`, `BLOCKED BY POLICY`, `UNCONFIGURED`, `UNSUPPORTED`, or `NOT TESTED`. Use **BLOCKED BY POLICY** only when the browser or organization explicitly reports a policy block; an absent browser feature or install prompt is not proof of policy.

## Before Testing

- Confirm JARVIS was started by the repository's browser or PWA script and the displayed address is loopback (`127.0.0.1`).
- Open the address in the organization's supported Microsoft Edge channel and verify the API status is reachable.
- Confirm the local backend operator configured the intended STT/LLM providers, workspace roots, and permissions. Do not approve a permission merely to make a check pass.
- Open **Settings → Deployment → Browser Voice & Permissions**. Confirm the browser mode and provider status.
- Open **Settings → Managed Device Validation**. Export JSON or text if required by the approved support process; exports contain capability labels, status, details, and generation time only.

## Browser and PWA

- Verify the JARVIS page works in a normal Edge tab.
- If Edge offers its own install action, install only if allowed by organization policy; otherwise continue in the tab.
- If installed, reopen JARVIS from the installed app and confirm the standalone status. If no install action is offered, record the runtime as undetermined unless Edge explicitly reports a policy block.
- Confirm the service worker does not cache API or WebSocket traffic and that the app reconnects after a backend restart.
- Confirm a waiting service-worker update is applied only after the explicit update action.

## Microphone and Speech-to-Text

- In Settings, explicitly allow microphone access for this browser origin. Do not change system or organization policy.
- Verify the configured microphone is listed after permission is granted; revoke permission in browser site settings and verify JARVIS reports denial without retry loops.
- With STT configured, start voice using the composer button and the enabled in-page shortcut. Confirm the level meter responds, speak a harmless test phrase, release/stop, and verify one transcription is submitted through the normal command route.
- Verify the shortcut works only while JARVIS is focused on the command or conversation page. Confirm it does not trigger in text fields, editable regions, other routes, or when the browser page is unfocused.
- Verify a short tap starts/stops by toggle and a press-and-hold stops on release. Press Escape while the shortcut is held and confirm the recording is discarded.
- Test silence timeout, maximum recording duration, no-speech timeout, and size limit. Confirm no partial audio is sent and no recording is submitted after cancellation.
- With STT unconfigured or unavailable, confirm the exact provider status is shown, capture remains disabled, and no microphone permission prompt is opened.
- With a denied permission or missing microphone, confirm an understandable error appears and that the page remains usable for typed commands.

## Local Speech Output

- Verify the voice list includes only voices the browser reports as local. Select a local voice, volume, and rate, then activate **Test speech**.
- Enable response speech and confirm a completed response is spoken by the local browser engine. Confirm the setting off state produces no speech.
- Start a new recording during playback and verify speech is interrupted. Use Stop speech and verify the utterance ends immediately.
- Confirm no remote TTS request, voice cloning, audio file, or transcript is produced by browser-local speech playback.

## Notifications and Permissions

- Enable notifications only by activating **Enable notifications** and accepting the browser prompt. Confirm the setting remains off if permission is denied or dismissed.
- With permission granted and notifications enabled, verify only generic task-completed/task-failed, permission-requested, and provider-outage notifications can appear while the page is open.
- Confirm notification titles and bodies contain no transcript, task content, tool arguments, provider credentials, filesystem paths, or private response text.
- Disable notifications in Settings and verify events continue to appear only in the in-app notice area.
- Deny or revoke browser notification permission and verify the in-app notice area remains functional without repeated prompts.

## Directory and Backend Authority

- Activate **Choose directory** and select a user-approved test directory. Verify only its name is shown and the selection is not persisted after reload.
- Cancel the picker and verify no error is reported. Where unsupported, verify the page states the picker is unavailable.
- Confirm selecting a browser directory does not expose files to JARVIS or alter workspace roots. Backend workspace tools must still use operator-approved roots and existing permission/confirmation flows.
- Verify a denied backend permission remains denied and is reflected in audit history; do not use validation to auto-approve actions.

## Security and Privacy

- Verify no browser `SpeechRecognition`/`webkitSpeechRecognition` path is active and no audio is sent to a browser-vendor speech service.
- Verify session tokens do not appear in storage, URLs, browser history, diagnostic exports, or service-worker cache.
- Verify browser APIs remain loopback-only and that HTTPS certificate validation, browser policy, and OS security settings are unchanged.
- Verify command and permission outcomes remain in the backend audit trail. Diagnostic exports must not include tokens, audio, transcripts, command text, tool arguments, or credentials.
- Verify cancel, permission denial, unavailable provider, and backend disconnect do not leave a live microphone track or retained recording.

## Results

- Record the browser version/channel, JARVIS build identifier, date, test status for each applicable check, and any sanitized error code through the approved support workflow.
- Do not include user transcripts, file paths, credentials, tokens, recordings, or tool arguments in exported reports or support tickets.
- Automated tests and localhost smoke checks do not replace these target-device checks. Do not describe managed-device readiness as verified until the applicable checks above have been completed.
