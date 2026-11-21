import { useMemo, useState } from "react";
import { MessageSquareText, Search, Sparkles } from "lucide-react";
import { api } from "@/services/api";
import { useQuery } from "@tanstack/react-query";
import { Badge, EmptyState, PageHeading, Panel } from "@/components/ui";
import type { OrchestrationResult } from "@/types/contracts";

function time(value?: string) { return value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Time not provided"; }

function citationsFrom(output: Record<string, unknown> | null): string[] {
  const citations = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, nested]) => {
        if (key === "citation" && typeof nested === "string" && /^https:\/\//i.test(nested)) {
          citations.add(nested);
        } else {
          visit(nested);
        }
      });
    }
  };
  visit(output);
  return [...citations].slice(0, 8);
}

export function ConversationPage() {
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const history = useQuery({ queryKey: ["assistant", "history", 200], queryFn: ({ signal }) => api.history({ limit: 200 }, signal) });
  const records = history.data ?? [];
  const conversations = useMemo(() => {
    const groups = new Map<string, OrchestrationResult[]>();
    records.forEach((record) => groups.set(record.conversationId, [...(groups.get(record.conversationId) ?? []), record]));
    return [...groups.entries()].map(([conversationId, items]) => ({ conversationId, items: items.sort((a, b) => (b.assistantMessage?.createdAt ?? "").localeCompare(a.assistantMessage?.createdAt ?? "")) }));
  }, [records]);
  const filtered = conversations.filter(({ items }) => items.some((item) => `${item.assistantMessage?.content ?? ""} ${item.intent?.summary ?? ""}`.toLowerCase().includes(filter.toLowerCase())));
  const activeConversation = filtered.find((item) => item.conversationId === selectedId) ?? filtered[0];
  const active = activeConversation?.items ?? [];

  return <div className="page-content">
    <PageHeading eyebrow="HISTORY / MESSAGES" title="Conversations" description="Review persisted task outcomes. Raw user transcripts are not exposed by the current history API." />
    <div className="conversation-workspace"><Panel className="conversation-list-panel"><div className="conversation-search"><Search size={15} /><input placeholder="Filter returned history" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter conversation history" /></div>{history.isLoading ? <div className="loading-row">Loading persisted history…</div> : history.isError ? <p className="inline-error">{history.error.message}</p> : filtered.map(({ conversationId, items }) => <button className={`conversation-item ${activeConversation?.conversationId === conversationId ? "selected" : ""}`} key={conversationId} onClick={() => setSelectedId(conversationId)}><span className="conversation-icon"><MessageSquareText size={16} /></span><span><strong>{items[0]?.assistantMessage?.content.slice(0, 46) || items[0]?.intent?.summary || "Assistant session"}</strong><small>{items.length} command{items.length === 1 ? "" : "s"} · {time(items[0]?.assistantMessage?.createdAt ?? "")}</small></span><i /></button>)}{!history.isLoading && !filtered.length && <EmptyState icon={<MessageSquareText size={20} />} title="No saved conversations" body="Commands will appear after the backend stores their task history." />}</Panel>
      <Panel className="conversation-detail">{active.length ? <><div className="conversation-detail-heading"><div><p className="eyebrow">SESSION {activeConversation?.conversationId.slice(0, 8)}</p><h2>Conversation record</h2></div><Badge>{active.length} command{active.length === 1 ? "" : "s"}</Badge></div><div className="conversation-records">{active.map((item) => <article className="conversation-record" key={item.commandId}><div className="record-marker"><Sparkles size={15} /></div><div className="record-body"><div className="record-meta"><Badge tone={item.status === "completed" ? "green" : item.status === "failed" ? "danger" : "neutral"}>{item.status}</Badge><time>{time(item.assistantMessage?.createdAt ?? "")}</time></div>{item.intent && <p className="intent-summary">{item.intent.summary}</p>}{item.assistantMessage && <p className="record-message">{item.assistantMessage.content}</p>}{item.plan?.steps.length ? <div className="record-steps"><strong>Plan</strong>{item.plan.steps.map((step) => <span key={step.stepId}>{step.description}</span>)}</div> : null}{item.toolResults.map((result) => <div className="record-tool" key={result.toolCallId}><span>{result.toolId}</span><Badge tone={result.status === "succeeded" ? "green" : "amber"}>{result.status}</Badge><p>{result.summary}</p>{citationsFrom(result.output).map((citation) => <p className="source-citation" key={citation} title={citation}>Source: {citation}</p>)}</div>)}{item.errorCode && <p className="inline-error">{item.errorCode}</p>}</div></article>)}</div></> : <EmptyState icon={<MessageSquareText size={20} />} title="Select a conversation" body="Persisted command and response records appear here." />}</Panel></div>
  </div>;
}