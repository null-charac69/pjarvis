import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { registerPwa } from "@/services/deployment";
import "@/styles/tokens.css";
import "@/styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("The desktop root element is missing.");

createRoot(root).render(<StrictMode><App /></StrictMode>);

if (!import.meta.env.DEV) {
	void registerPwa(() => window.dispatchEvent(new Event("jarvis-pwa-update"))).catch(() => undefined);
}