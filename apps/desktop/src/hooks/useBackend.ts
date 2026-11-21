import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";

export const backendKeys = {
  health: ["backend", "health"] as const,
  llmHealth: ["backend", "llm-health"] as const,
};

export function useBackendHealth() {
  return useQuery({
    queryKey: backendKeys.health,
    queryFn: ({ signal }) => api.health(signal),
    retry: 1,
    refetchInterval: 15_000,
  });
}

export function useLlmHealth() {
  return useQuery({
    queryKey: backendKeys.llmHealth,
    queryFn: ({ signal }) => api.llmHealth(signal),
    retry: 1,
    refetchInterval: 30_000,
  });
}