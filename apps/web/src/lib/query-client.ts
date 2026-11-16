import { QueryClient } from "@tanstack/react-query";

/**
 * Shared by the provider and by route loaders, which run outside React and so
 * cannot reach the client through context.
 */
export const queryClient = new QueryClient();
