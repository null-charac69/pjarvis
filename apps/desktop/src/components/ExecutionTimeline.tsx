import { ArrowDownRight, Check, Circle, Clock3, ShieldAlert, Wrench, X } from "lucide-react";
import type { ConversationActivity, OrchestrationResult } from "@/types/contracts";

function clockTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const kindIcon = {
  user: ArrowDownRight,
  assistant: Check,
  plan: Circle,
  tool: Wrench,
  state: ShieldAlert,
};

export function ExecutionTimeline({ items, task }: { items: ConversationActivity[]; task?: OrchestrationResult | null }) {
  const fromTask: ConversationActivity[] = [];
  if (task?.plan) {
    task.plan.steps.forEach((step) => fromTask.push({
      id: `${task.taskId}-${step.stepId}`,
      kind: "plan",
      content: step.description,
      createdAt: task.assistantMessage?.createdAt ?? new Date().toISOString(),
      taskId: task.taskId,
      toolId: step.toolCall?.toolId,
    }));
  }
  task?.toolResults.forEach((result) => fromTask.push({
    id: result.toolCallId,
    kind: "tool",
    content: result.summary,
    createdAt: task.assistantMessage?.createdAt ?? new Date().toISOString(),
    taskId: task.taskId,
    toolId: result.toolId,
    status: result.status,
  }));
  if (task?.assistantMessage) fromTask.push({
    id: task.assistantMessage.messageId,
    kind: "assistant",
    content: task.assistantMessage.content,
    createdAt: task.assistantMessage.createdAt,
    taskId: task.taskId,
  });

  const merged = [...items, ...fromTask].reduce<ConversationActivity[]>((all, item) => {
    if (!all.some((current) => current.id === item.id)) all.push(item);
    return all;
  }, []).slice(-10);
  if (merged.length === 0) return <div className="timeline-empty"><Clock3 size={16} /><span>Requests and verified execution steps will appear here.</span></div>;

  return <div className="execution-timeline">{merged.map((item) => {
    const Icon = kindIcon[item.kind];
    const outcome = item.status === "failed" || item.status === "denied";
    return <article className={`timeline-item timeline-${item.kind}`} key={item.id}>
      <span className={`timeline-icon ${outcome ? "has-error" : ""}`}>{outcome ? <X size={13} /> : <Icon size={13} />}</span>
      <div className="timeline-copy"><p>{item.content}</p><div><span>{item.kind === "tool" ? item.toolId ?? "Tool activity" : item.kind}</span><time>{clockTime(item.createdAt)}</time></div></div>
    </article>;
  })}</div>;
}