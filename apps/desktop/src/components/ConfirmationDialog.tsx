import { AlertTriangle, Check, LockKeyhole, ShieldCheck, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "@/state/app-store";
import { useResolveConfirmation } from "@/hooks/useConfirmations";
import { Button, Badge } from "@/components/ui";

export function ConfirmationDialog() {
  const pending = useAppStore((state) => state.pendingConfirmation);
  const resolve = useResolveConfirmation();
  if (!pending) return null;
  const risk = pending.mode === "assistant" ? pending.riskLevel : pending.ticket?.riskLevel ?? "Review";
  const scopes = pending.mode === "assistant" ? pending.scopes : pending.ticket?.scopes ?? [];
  const args = pending.mode === "assistant" ? pending.arguments : pending.ticket?.arguments ?? pending.arguments;
  const resources = pending.mode === "assistant" ? pending.resources : pending.ticket?.resources ?? [];

  return <Dialog.Root open>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-backdrop" />
      <Dialog.Content className="confirmation-dialog" onEscapeKeyDown={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}>
    <div className="confirm-header"><div className="confirm-icon"><AlertTriangle size={20} /></div><div><p className="eyebrow">Permission checkpoint</p><Dialog.Title>Review this action</Dialog.Title></div></div>
    <Dialog.Description asChild><p className="confirm-intro">The backend requires your approval before this action can continue. Review the request carefully; approval does not bypass any backend policy.</p></Dialog.Description>
    <div className="confirm-target"><span>TOOL</span><strong>{pending.toolId}</strong><Badge tone={risk === "HIGH" || risk === "BLOCKED" ? "danger" : "amber"}>{risk}</Badge></div>
    <div className="confirm-data"><div><span>PERMISSION SCOPES</span><div className="scope-list">{scopes.length ? scopes.map((scope) => <code key={scope}>{scope}</code>) : <span>Not provided</span>}</div></div>
      <div><span>AFFECTED RESOURCES</span><p>{resources.length ? resources.join(", ") : "Not provided"}</p></div>
      <div><span>MASKED ARGUMENTS</span><pre>{JSON.stringify(args, null, 2)}</pre></div>
    </div>
    <div className="confirm-policy"><LockKeyhole size={15} /><span>One-time approval is recommended. Session approval creates a backend permission grant.</span></div>
    {resolve.isError && <p className="inline-error" role="alert">{resolve.error.message}</p>}
    <div className="confirm-actions"><Button variant="danger" disabled={resolve.isPending} onClick={() => resolve.mutate("denied")}><X size={15} /> Deny</Button><Button variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate("approved_session")}><ShieldCheck size={15} /> Approve for session</Button><Button variant="solid" disabled={resolve.isPending} onClick={() => resolve.mutate("approved_once")}><Check size={15} /> Approve once</Button></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}