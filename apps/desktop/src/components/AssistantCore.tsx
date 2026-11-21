import { motion, useReducedMotion } from "framer-motion";
import { Activity, AudioLines, CircleAlert, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import type { AssistantState } from "@/types/contracts";
import { StatusDot } from "@/components/ui";
import { useAppStore } from "@/state/app-store";

const stateCopy: Partial<Record<AssistantState, string>> = {
  idle: "Ready when you are",
  listening: "Listening for your command",
  transcribing: "Transcribing your recording",
  thinking: "Working through your request",
  planning: "Preparing a safe plan",
  executing: "Running approved actions",
  awaiting_confirmation: "Your approval is needed",
  completed: "Request complete",
  speaking: "Speaking response",
  failed: "The request could not complete",
  offline: "Backend connection unavailable",
};

export function AssistantCore({ state }: { state: AssistantState }) {
  const reduced = useReducedMotion();
  const voiceLevel = useAppStore((store) => store.voiceLevel);
  const busy = ["thinking", "planning", "executing", "speaking"].includes(state);
  const error = state === "failed" || state === "offline";
  return <div className={`assistant-core state-${state.replaceAll("_", "-")}`}>
    <div className="core-label"><StatusDot state={state} /><span>ASSISTANT</span><span className="core-label-line" /></div>
    <div className="core-stage">
      <motion.div className="core-ring ring-outer" animate={reduced ? undefined : { rotate: 360 }} transition={{ duration: 42, ease: "linear", repeat: Infinity }} />
      <motion.div className="core-ring ring-middle" animate={reduced ? undefined : { rotate: -360 }} transition={{ duration: 28, ease: "linear", repeat: Infinity }} />
      <div className="core-spectrum" aria-hidden="true">{Array.from({ length: 31 }, (_, index) => <i key={index} style={{ "--bar": index, height: state === "listening" ? `${Math.max(1, Math.min(24, voiceLevel * 240))}px` : "3px" } as CSSProperties} />)}</div>
      <div className="core-center"><div className="core-center-inner">{error ? <CircleAlert size={28} /> : busy ? <AudioLines size={29} /> : <Sparkles size={28} />}</div></div>
      <div className="core-orbit-pip pip-a" /><div className="core-orbit-pip pip-b" />
    </div>
    <p className="core-state">{stateCopy[state] ?? state.replaceAll("_", " ")}</p>
    <span className="core-caption"><Activity size={12} /> {state === "listening" ? "MICROPHONE ACTIVE · LOCAL VAD" : state === "speaking" ? "SPEECH OUTPUT ACTIVE" : "VOICE INPUT ON DEMAND"}</span>
  </div>;
}