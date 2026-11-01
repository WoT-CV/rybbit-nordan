import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../api/utils";

interface Configs {
  disableSignup: boolean;
  mapboxToken: string;
  liteDashboard: boolean;
  emailEnabled: boolean;
  gscEnabled: boolean;
  weeklyReportsEnabled: boolean;
  sourceCodeUrl?: string;
}

export function getSourceCodeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\//i.test(value) || /[\s\\?#]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const normalized = url.href;
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      normalized.length <= 2048
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

export function useConfigs() {
  const { data, isLoading, error } = useQuery<Configs>({
    queryKey: ["configs"],
    queryFn: () => authedFetch<Configs>("/config"),
  });

  return {
    configs: data,
    isLoading,
    error,
  };
}
