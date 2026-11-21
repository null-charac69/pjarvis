import { useRef, useState, type FormEvent } from "react";
import { ArrowUp, LoaderCircle, Mic, Paperclip, ShieldCheck, Square, VolumeX, X } from "lucide-react";
import { useSubmitCommand } from "@/hooks/useAssistant";
import { useVoice } from "@/hooks/useVoice";
import { Button } from "@/components/ui";
import { isBrowserDeployment } from "@/services/deployment";
import { useAppStore } from "@/state/app-store";

export function CommandComposer() {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const submit = useSubmitCommand();
  const voice = useVoice();
  const browser = isBrowserDeployment();
  const voiceLevel = useAppStore((state) => state.voiceLevel);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  const pointerStartedAt = useRef(0);
  const pointerHandled = useRef(false);
  const submitting = submit.isPending;

  function send(event: FormEvent) {
    event.preventDefault();
    const transcript = text.trim();
    if (!transcript || submitting) return;
    submit.mutate({ transcript });
    setText("");
    if (field.current) field.current.style.height = "auto";
  }

  return <form className="command-composer" onSubmit={send}>
    <div className="composer-topline"><span><ShieldCheck size={13} /> LOCAL COMMAND</span><span>Enter to send · Shift+Enter for a new line</span></div>
    <textarea
      ref={field}
      aria-label="Enter a command"
      placeholder="What would you like me to do?"
      rows={2}
      maxLength={4000}
      value={text}
      disabled={submitting}
      onChange={(event) => {
        setText(event.target.value);
        event.currentTarget.style.height = "auto";
        event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
    <div className="composer-controls"><div className="composer-tools">
      <Button type="button" size="icon" title="File ingestion is not available yet" aria-label="File ingestion unavailable" disabled><Paperclip size={16} /></Button>
      <Button
        type="button"
        size="icon"
        title={voice.recording ? "Release to transcribe" : "Hold to speak"}
        aria-label={voice.recording ? "Stop voice recording" : "Hold to speak"}
        aria-pressed={voice.recording}
        disabled={!voice.voiceAvailable || voice.transcribing}
        className={voice.recording ? "voice-recording" : ""}
        onPointerDown={(event) => {
          event.preventDefault();
          pointerStartedAt.current = Date.now();
          pointerHandled.current = true;
          if (browser && voice.recording) void voice.stopRecording();
          else void voice.startRecording();
        }}
        onPointerUp={() => {
          if (!browser || Date.now() - pointerStartedAt.current >= 350) void voice.stopRecording();
        }}
        onPointerLeave={() => { if (browser ? Date.now() - pointerStartedAt.current >= 350 : voice.recording) void voice.stopRecording(); }}
        onPointerCancel={() => void voice.stopRecording("cancelled")}
        onClick={(event) => {
          if (pointerHandled.current) {
            pointerHandled.current = false;
            event.preventDefault();
            return;
          }
          if (voice.recording) void voice.stopRecording();
          else void voice.startRecording();
        }}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            event.preventDefault();
            pointerHandled.current = true;
            void voice.startRecording();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            void voice.stopRecording();
          }
        }}
      >{voice.recording ? <Square size={14} /> : <Mic size={16} />}</Button>
      {(voice.recording || activeTaskId) && <Button type="button" size="icon" title={voice.recording ? "Cancel recording and discard audio" : "Cancel active task"} aria-label={voice.recording ? "Cancel recording" : "Cancel active task"} onClick={() => voice.recording ? void voice.stopRecording("cancelled") : void voice.cancelActiveTask()}><X size={15} /></Button>}
      {voice.speaking && <Button type="button" size="icon" title="Stop speech playback" aria-label="Stop speech playback" onClick={() => voice.interruptSpeech()}><VolumeX size={15} /></Button>}
      <span className="composer-limit">{text.length}/4000</span>
    </div><Button type="submit" variant="solid" className="send-button" disabled={!text.trim() || submitting} aria-label="Send command">{submitting ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}<span>{submitting ? "Sending" : "Send command"}</span></Button></div>
    {browser && !voice.speechToTextReady && <p className="voice-transcript" role="status">{voice.speechToTextStatus === "unconfigured" ? "Speech-to-text provider not configured." : voice.speechToTextStatus === "unavailable" || voice.speechToTextStatus === "degraded" ? "Speech-to-text provider is unavailable." : "Checking local speech-to-text provider…"}</p>}
    {voice.recording && <div className="voice-transcript" role="status" aria-live="polite"><span>Listening · {Math.floor(voice.durationMs / 1000).toString().padStart(2, "0")}s · Escape cancels</span><div className="voice-level-meter" role="progressbar" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(voiceLevel * 100))}><span style={{ transform: `scaleX(${Math.min(1, Math.max(0, voiceLevel * 8))})` }} /></div></div>}
    {voice.partialTranscript && <p className="voice-transcript" aria-live="polite">{voice.transcribing ? "Transcribing…" : voice.partialTranscript}</p>}
    {voice.error && <p className="inline-error voice-error" role="alert">{voice.error}</p>}
    {submit.isError && <p className="inline-error" role="alert">{submit.error.message}</p>}
  </form>;
}