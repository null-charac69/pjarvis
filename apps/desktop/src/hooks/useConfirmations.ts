import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore, type PendingConfirmationInput } from "@/state/app-store";
import { taskKeys } from "@/hooks/useTasks";
import { toolKeys } from "@/hooks/useTools";

export function useResolveConfirmation() {
  const client = useQueryClient();
  const pending = useAppStore((state) => state.pendingConfirmation);
  const setPending = useAppStore((state) => state.setPendingConfirmation);
  const setLatestTask = useAppStore((state) => state.setLatestTask);
  const setAppError = useAppStore((state) => state.setAppError);

  return useMutation({
    mutationFn: async (decision: "approved_once" | "approved_session" | "denied") => {
      if (!pending) throw new Error("There is no pending confirmation.");
      if (pending.mode === "assistant") {
        const result = await api.resolveAssistantConfirmation(pending.commandId, decision);
        return { result, pending };
      }
      await api.resolveDirectConfirmation(pending.confirmationId, decision);
      const result = decision === "denied"
        ? null
        : await api.executeTool(pending.toolId, pending.arguments, pending.confirmationId);
      return { result, pending };
    },
    onSuccess: ({ result }) => {
      if (result && "taskId" in result) setLatestTask(result);
      setPending(null);
      setAppError(null);
      void client.invalidateQueries({ queryKey: taskKeys.history });
      void client.invalidateQueries({ queryKey: toolKeys.all });
    },
    onError: (error) => setAppError(error instanceof Error ? error.message : "The decision could not be recorded."),
  });
}

export function assistantConfirmation(
  task: {
    commandId: string;
    taskId: string;
    confirmationRequest: {
      confirmationId: string;
      toolId: string;
      riskLevel: string;
      scopes: string[];
      maskedArguments: Record<string, unknown>;
      affectedResources: string[];
    } | null;
  },
): PendingConfirmationInput | null {
  const ticket = task.confirmationRequest;
  if (!ticket) return null;
  return {
    mode: "assistant",
    commandId: task.commandId,
    taskId: task.taskId,
    confirmationId: ticket.confirmationId,
    toolId: ticket.toolId,
    riskLevel: ticket.riskLevel,
    scopes: ticket.scopes,
    arguments: ticket.maskedArguments,
    resources: ticket.affectedResources,
  };
}