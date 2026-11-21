# Known Limitations

## Restricted Browser Profile

- Browser mode requires the API and renderer processes to remain running. The page must remain open for voice capture and page-bound interactions; hidden-page wake monitoring stops.
- Push-to-talk records only after a user action. Transcription requires an explicitly configured backend STT provider. Browser SpeechRecognition is detected for capability reporting but is not used because implementations can send audio to a browser-vendor service.
- Browser speech synthesis depends on voices installed and exposed by the browser. It has not been validated against the managed device's available voices.
- PWA build and local preview are validated, but Edge installation availability, organization policy, and installed-app lifecycle have not been tested on a managed target.
- Browser microphone permission, denial behavior with a physical device, real speech recognition, WebSocket connectivity in Edge, and the full permission/audit workflow require target-device testing.
- The startup profile uses `%LOCALAPPDATA%\JARVIS\data`; the managed launcher does not yet expose a user-selected directory.
- The supervisor chooses free loopback ports in a bounded range. Operators should use the URL it prints rather than assuming defaults.

## Providers and Integrations

- External LLM, STT, search, weather, and other providers remain unavailable until explicitly configured by the operator. No provider credentials or speech models are downloaded by the application.
- Electron packaging metadata and automated tests exist, but Electron runtime launch, signing, installer lifecycle, and installed-app smoke tests are not established in this environment.
- Live PostgreSQL integration, organization security approval, penetration testing, and general production certification remain outstanding.

These limits are intentionally reported rather than bypassed through changes to organization policy, TLS validation, or machine configuration.