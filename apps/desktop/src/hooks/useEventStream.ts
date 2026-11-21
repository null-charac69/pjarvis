import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BackendEventStream } from "@/services/events";
import { useAppStore } from "@/state/app-store";
import { backendKeys } from "@/hooks/useBackend";
import { taskKeys } from "@/hooks/useTasks";
import { toolKeys } from "@/hooks/useTools";

export function useEventStream() {
  const client = useQueryClient();
  const pushEvent = useAppStore((state) => state.pushEvent);
  const setEventConnection = useAppStore((state) => state.setEventConnection);

  useEffect(() => {
    const stream = new BackendEventStream((event) => {
      pushEvent(event);
      if (event.type === "task.updated") {
        void client.invalidateQueries({ queryKey: taskKeys.history });
        void client.invalidateQueries({ queryKey: ["tasks", event.payload.taskId] });
      } else if (event.type.startsWith("tool.")) {
        void client.invalidateQueries({ queryKey: toolKeys.all });
      } else if (event.type === "provider.health.changed") {
        void client.invalidateQueries({ queryKey: backendKeys.llmHealth });
      }
    }, (connection) => {
      setEventConnection(connection);
      if (connection !== "connected") return;
      void client.invalidateQueries({ queryKey: backendKeys.health });
      void client.invalidateQueries({ queryKey: backendKeys.llmHealth });
      void client.invalidateQueries({ queryKey: taskKeys.history });
      void client.invalidateQueries({ queryKey: toolKeys.all });
      const activeTaskId = useAppStore.getState().activeTaskId;
      if (activeTaskId) {
        void client.invalidateQueries({ queryKey: taskKeys.detail(activeTaskId) });
      }
    });
    void stream.connect();
    return () => stream.close();
  }, [client, pushEvent, setEventConnection]);
}