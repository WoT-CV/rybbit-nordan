import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { toast } from "../components/ui/sonner";
import { authClient } from "../lib/auth";
import { userStore } from "../lib/userStore";

export function useSignout(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const t = useExtracted();

  return async () => {
    try {
      const result = await authClient.signOut();
      if (result.error || result.data?.success !== true) {
        toast.error(t("An error occurred. Please try again later."));
        return false;
      }
    } catch {
      toast.error(t("An error occurred. Please try again later."));
      return false;
    }
    // A confirmed logout wins over any older, still-pending session bootstrap.
    userStore.setState({ user: null, isPending: false });
    queryClient.clear();
    if (onSuccess) onSuccess();
    else router.push("/login");
    return true;
  };
}
