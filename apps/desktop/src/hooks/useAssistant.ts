import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAppStore } from "@/state/app-store";
import { taskKeys } from "@/hooks/useTasks";
import type { ConversationActivity } from "@/types/contracts";

export function useSubmitCommand() {
  const client = useQueryClient();
  const setLatestTask = useAppStore((state) => state.setLatestTask);
  const addTimeline = useAppStore((state) => state.addTimeline);
  const setAppError = useAppStore((state) => state.setAppError);

  return useMutation({
    mutationFn: ({ transcript, conversationId }: { transcript: string; conversationId?: string }) =>
      api.submitCommand(transcript, conversationId),
    onMutate: ({ transcript }) => {
      const activity: ConversationActivity = {
        id: `local-${crypto.randomUUID()}`,
        kind: "user",
        content: transcript,
        createdAt: new Date().toISOString(),
      };
      addTimeline(activity);
      setAppError(null);
    },
    onSuccess: (task) => {
      setLatestTask(task);
      void client.invalidateQueries({ queryKey: taskKeys.history });
    },
    onError: (error) => {
      setAppError(error instanceof Error ? error.message : "The command could not be sent.");
    },
  });
}