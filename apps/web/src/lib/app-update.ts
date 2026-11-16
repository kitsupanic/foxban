export const APP_UPDATE_CHECK_EVENT = "foxban:update-check";
export const APP_UPDATE_PROMPT_ACTIVE_ATTR = "data-foxban-update-prompt-active";

export function requestAppUpdateCheck(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(APP_UPDATE_CHECK_EVENT));
  }
}

export async function fetchCurrentBuildId(signal?: AbortSignal): Promise<string | null> {
  try {
    const currentId = typeof __FOXBAN_BUILD_ID__ === "string" ? __FOXBAN_BUILD_ID__ : "";
    const params = new URLSearchParams({
      current: currentId,
      t: Date.now().toString(),
    });
    const res = await fetch(`/foxban-version.json?${params.toString()}`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok) {
      return null;
    }
    const data: unknown = await res.json();
    if (
      data !== null &&
      typeof data === "object" &&
      "buildId" in data &&
      typeof data.buildId === "string"
    ) {
      const trimmed = data.buildId.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    return null;
  } catch {
    return null;
  }
}
