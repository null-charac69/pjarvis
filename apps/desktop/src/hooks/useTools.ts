import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore } from "@/state/app-store";

export const toolKeys = {
  all: ["tools"] as const,
  list: ["tools", "list"] as const,
  health: (toolId: string) => ["tools", "health", toolId] as const,
};

export function useTools() {
  return useQuery({
    queryKey: toolKeys.list,
    queryFn: ({ signal }) => api.listTools(signal),
    staleTime: 10_000,
  });
}

export function useToolHealth(toolId: string, enabled = true) {
  return useQuery({
    queryKey: toolKeys.health(toolId),
    queryFn: ({ signal }) => api.toolHealth(toolId, signal),
    enabled: enabled && Boolean(toolId),
  });
}

export function useToggleTool() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ toolId, enabled }: { toolId: string; enabled: boolean }) =>
      api.setToolEnabled(toolId, enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useExecuteTool() {
  const setPendingConfirmation = useAppStore((state) => state.setPendingConfirmation);
  return useMutation({
    mutationFn: ({ toolId, arguments: arguments_ }: { toolId: string; arguments: Record<string, unknown> }) =>
      api.executeTool(toolId, arguments_),
    onSuccess: async (execution, variables) => {
      const { result, confirmationId } = execution;
      if (result.status !== "confirmation_required" || !confirmationId) return;
      try {
        const ticket = await api.getConfirmation(confirmationId);
        setPendingConfirmation({
          mode: "tool",
          toolId: variables.toolId,
          arguments: variables.arguments,
          confirmationId,
          ticket: {
            riskLevel: ticket.risk_level,
            scopes: ticket.scopes,
            arguments: ticket.masked_arguments,
            resources: ticket.affected_resources,
          },
        });
      } catch {
        setPendingConfirmation({
          mode: "tool",
          toolId: variables.toolId,
          arguments: variables.arguments,
          confirmationId,
        });
      }
    },
  });
}