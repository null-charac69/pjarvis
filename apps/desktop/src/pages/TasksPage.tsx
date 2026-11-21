import { useMemo, useState } from "react";
import { CalendarClock, CirclePause, CirclePlay, ListTodo, RefreshCw, X } from "lucide-react";
import { useTaskHistory, useCancelTask } from "@/hooks/useTasks";
import { Badge, Button, EmptyState, PageHeading, Panel } from "@/components/ui";
import type { TaskStatus } from "@/types/contracts";

const filters: Array<"all" | TaskStatus> = ["all", "running", "awaiting_confirmation", "completed", "failed", "cancelled"];

export function TasksPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const history = useTaskHistory(200);
  const cancel = useCancelTask();
  const tasks = useMemo(() => (history.data ?? []).filter((task) => filter === "all" || task.status === filter), [history.data, filter]);

  return <div className="page-content">
    <PageHeading eyebrow="EXECUTION / QUEUE" title="Task queue" description="Inspect persisted assistant tasks, their results, and current execution state." action={<Button onClick={() => void history.refetch()}><RefreshCw size={15} /> Refresh</Button>} />
    <div className="task-filter-bar">{filters.map((value) => <button key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{value === "all" ? "All tasks" : value.replaceAll("_", " ")}</button>)}</div>
    <Panel className="task-table-panel">{history.isLoading ? <div className="loading-row">Loading task history…</div> : history.isError ? <p className="inline-error">{history.error.message}</p> : tasks.length ? <div className="task-list">{tasks.map((task) => <article className="task-row" key={task.taskId}><div className={`task-status-icon task-${task.status}`}>{task.status === "running" ? <CirclePlay size={17} /> : task.status === "awaiting_confirmation" ? <CirclePause size={17} /> : task.status === "completed" ? <CirclePlay size={17} /> : <ListTodo size={17} />}</div><div className="task-primary"><div><strong>{task.intent?.summary ?? task.assistantMessage?.content ?? "Assistant command"}</strong><Badge tone={task.status === "completed" ? "green" : task.status === "failed" ? "danger" : task.status === "awaiting_confirmation" ? "amber" : "neutral"}>{task.status.replaceAll("_", " ")}</Badge></div><span>Task {task.taskId.slice(0, 8)} · Conversation {task.conversationId.slice(0, 8)}</span></div><div className="task-meta"><span>{task.toolResults.length} tool result{task.toolResults.length === 1 ? "" : "s"}</span><time>{task.assistantMessage ? new Date(task.assistantMessage.createdAt).toLocaleString() : "Awaiting result"}</time></div>{["pending", "running", "awaiting_confirmation"].includes(task.status) && <Button size="small" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate(task.taskId)} aria-label={`Cancel task ${task.taskId}`}><X size={14} /> Cancel</Button>}</article>)}</div> : <EmptyState icon={<ListTodo size={21} />} title="No tasks in this view" body="Assistant command executions will be listed with their backend status." />}</Panel>
    <div className="capability-notice"><CalendarClock size={17} /><div><strong>Scheduled tasks are not available</strong><span>The backend does not expose scheduling or recurring automation endpoints yet. No background schedule is being simulated.</span></div><Badge tone="neutral">Unavailable</Badge></div>
  </div>;
}