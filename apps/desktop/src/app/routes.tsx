import { createBrowserRouter, createHashRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/layouts/AppShell";
import { isBrowserDeployment } from "@/services/deployment";

export const appRoutes = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, lazy: async () => ({ Component: (await import("@/pages/CommandCenterPage")).CommandCenterPage }) },
      { path: "conversation", lazy: async () => ({ Component: (await import("@/pages/ConversationPage")).ConversationPage }) },
      { path: "tasks", lazy: async () => ({ Component: (await import("@/pages/TasksPage")).TasksPage }) },
      { path: "tools", lazy: async () => ({ Component: (await import("@/pages/ToolsPage")).ToolsPage }) },
      { path: "memory", lazy: async () => ({ Component: (await import("@/pages/MemoryPage")).MemoryPage }) },
      { path: "files", lazy: async () => ({ Component: (await import("@/pages/FilesPage")).FilesPage }) },
      { path: "system", lazy: async () => ({ Component: (await import("@/pages/SystemMonitorPage")).SystemMonitorPage }) },
      { path: "capabilities", lazy: async () => ({ Component: (await import("@/pages/CapabilitiesPage")).CapabilitiesPage }) },
      { path: "audit", lazy: async () => ({ Component: (await import("@/pages/AuditPage")).AuditPage }) },
      { path: "settings", lazy: async () => ({ Component: (await import("@/pages/SettingsPage")).SettingsPage }) },
      { path: "settings/deployment/validation", lazy: async () => ({ Component: (await import("@/pages/ManagedDeviceValidationPage")).ManagedDeviceValidationPage }) },
      { path: "notifications", lazy: async () => ({ Component: (await import("@/pages/NotificationsPage")).NotificationsPage }) },
      { path: "onboarding", lazy: async () => ({ Component: (await import("@/pages/OnboardingPage")).OnboardingPage }) },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export function createAppRouter(browserDeployment = isBrowserDeployment()) {
  return browserDeployment ? createBrowserRouter(appRoutes) : createHashRouter(appRoutes);
}

export const router = createAppRouter();