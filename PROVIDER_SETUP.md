# Provider Setup

## Status

The backend implements a deterministic mock provider and operator-configured OpenAI-compatible and Azure OpenAI LLM adapters. Voice uses an optional local faster-whisper adapter, an explicitly configured Azure Speech STT adapter, and an optional openWakeWord model adapter. Renderer speech output uses the operating-system browser speech engine. Selecting a provider does not mean its package/model/credentials are installed or healthy; check `GET /api/v1/voice/health`.

## LLM

Planned choices:

- `mock`: deterministic fixture behavior for development and tests; never representative of production answers.
- `openai_compatible`: live chat-completions adapter for a local vLLM or another operator-configured compatible endpoint.
- `azure_openai`: live Azure OpenAI chat-completions adapter using the operator-supplied endpoint, deployment, API version, and key.

Endpoint, deployment/model identifier, API version where applicable, temperature, token limit, and a credential reference are configuration inputs. No endpoint, model/deployment name, or credential is supplied by this repository. Local endpoints remain usable without a cloud LLM. The planner must validate structured output before any tool is considered.

To configure a local vLLM/OpenAI-compatible endpoint, select `openai_compatible` in `JARVIS_LLM_PROVIDER`, then set `JARVIS_LLM_BASE_URL` and `JARVIS_LLM_MODEL` to values supplied by its operator. `JARVIS_LLM_API_KEY` is optional only when the endpoint does not require authentication. Azure OpenAI uses the `JARVIS_AZURE_OPENAI_*` settings. No endpoint, model, deployment, or secret is supplied by this repository. Requests use structured JSON output; plans and every tool argument are validated before execution.

## Speech-to-Text

`faster_whisper` is local and requires the optional `voice-local` dependencies plus a pre-existing model directory. The application passes `local_files_only=True` and never downloads models. Set `JARVIS_STT_PROVIDER=faster_whisper`, `JARVIS_STT_MODEL_PATH`, and optional `JARVIS_STT_DEVICE` (`cpu`, `cuda`, or `auto`) and `JARVIS_STT_COMPUTE_TYPE` (`int8` by default). Install dependencies explicitly with `uv sync --group dev --extra voice-local`; provide the model directory through an operator-managed process, not the UI.

`azure` sends the active utterance to Azure Speech only when `JARVIS_STT_PROVIDER=azure`, `JARVIS_AZURE_SPEECH_REGION`, and `JARVIS_AZURE_SPEECH_KEY` are explicitly configured. Install the optional SDK with `uv sync --group dev --extra voice-azure`. The credential remains a backend `SecretStr`, is not returned to the renderer, and is never logged. Partial updates are separate recognition requests and may incur separate provider charges; use `faster_whisper` for local partials. Language defaults to `en-IN`. Raw audio is not retained by either adapter.

## Text-to-Speech

The desktop can use browser `speechSynthesis` when the user enables response playback. It selects only voices marked local by the operating system, follows the preferred language when a matching local voice exists, and can be interrupted. If no local voice is installed, playback remains unavailable instead of falling back to a possibly remote voice. Piper and Azure TTS are not implemented in this phase; selecting those backend values does not make them available.

## Wake Word

Wake monitoring is off by default. The openWakeWord adapter requires an existing local ONNX model path in `JARVIS_WAKE_MODEL_PATH`, provider selection `JARVIS_WAKE_PROVIDER=openwakeword`, and explicit microphone consent in desktop Settings. Model files are never downloaded automatically. The optional openWakeWord package is not included in uv extras because its universal dependency metadata resolves an unavailable Linux TFLite wheel for Python 3.12; install it through an operator-managed, compatible runtime. Without a model and package, health remains `unconfigured` or `unavailable`; push-to-talk remains available.

## Secrets and Health

LLM and Azure Speech secrets are supplied only through backend environment variables or deployment secret injection; never expose them to the renderer, source control, localStorage, logs, or audit records. `.env.example` contains empty placeholders only. Audio is bounded, transient, and not included in provider-health responses or general events.

LLM health is available at `GET /api/v1/assistant/providers/llm/health`; voice health is available at `GET /api/v1/voice/health`. Provider errors expose stable codes only, not credentials or raw provider response bodies. Automated tests use injected fakes and make no paid network calls or model downloads.

See [config/provider.schema.json](config/provider.schema.json) and [docs/troubleshooting.md](docs/troubleshooting.md).
