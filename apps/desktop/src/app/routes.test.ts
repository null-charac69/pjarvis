import { describe, expect, it } from "vitest";
import { appRoutes, createAppRouter } from "@/app/routes";

describe("application routes", () => {
  it("registers the managed validation path under Settings deployment", () => {
    const childPaths = appRoutes[0]?.children?.map((route) => route.path);
    expect(childPaths).toContain("settings/deployment/validation");
  });

  it("matches the direct browser URL and preserves Electron hash routing", async () => {
    const browserRouter = createAppRouter(true);
    await browserRouter.navigate("/settings/deployment/validation");
    expect(browserRouter.state.location.pathname).toBe("/settings/deployment/validation");
    browserRouter.dispose();

    const electronRouter = createAppRouter(false);
    expect(electronRouter.state.location.pathname).toBe("/");
    electronRouter.dispose();
  });
});
