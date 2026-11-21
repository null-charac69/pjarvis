import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore } from "@/state/app-store";

export const taskKeys = {
  history: ["assistant", "history"] as const,
  detail: (taskId: string) => ["tasks", taskId] as const,
};

export function useTaskHistory(limit = 100) {
  return useQuery({
    queryKey: [...taskKeys.history, limit],
    queryFn: ({ signal }) => api.history({ limit }, signal),
    staleTime: 5_000,
  });
}

export function useActiveTask() {
  const taskId = useAppStore((state) => state.activeTaskId);
  const setLatestTask = useAppStore((state) => state.setLatestTask);
  const taskQuery = useQuery({
    queryKey: taskKeys.detail(taskId ?? "none"),
    queryFn: ({ signal }) => api.getTask(taskId!, signal),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" || status === "awaiting_confirmation"
        ? 750
        : false;
    },
  });

  useEffect(() => {
    if (taskQuery.data) setLatestTask(taskQuery.data);
  }, [taskQuery.data, setLatestTask]);

  return taskQuery;
}

export function useCancelTask() {
  const client = useQueryClient();
  const setLatestTask = useAppStore((state) => state.setLatestTask);
  return useMutation({
    mutationFn: api.cancelTask,
    onSuccess: (task) => {
      setLatestTask(task);
      void client.invalidateQueries({ queryKey: taskKeys.history });
    },
  });
}