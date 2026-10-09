import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";

interface PreviewData {
  isTrialing?: boolean;
  currentPlan: {
    priceId: string;
    amount: number;
    interval: string;
  };
  newPlan: {
    priceId: string;
    amount: number;
    interval: string;
  };
  proration: {
    credit: number;
    charge: number;
    immediatePayment: number;
    nextBillingDate: string | null;
  };
}

interface PlanChangePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  previewData: PreviewData | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  isUpdating: boolean;
}

export function PlanChangePreviewDialog({
  open,
  onOpenChange,
  previewData,
  onConfirm,
  onCancel,
  isUpdating,
}: PlanChangePreviewDialogProps) {
  const t = useExtracted();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Confirm plan change")}</DialogTitle>
        </DialogHeader>

        {previewData && (
          <div className="space-y-4">
            {/* Current Plan */}
            <div className="text-sm">
              <div className="text-neutral-500 dark:text-neutral-400">{t("Current plan")}</div>
              <div className="text-neutral-900 dark:text-neutral-100 font-medium">
                ${previewData.currentPlan.amount / 100}/
                {previewData.currentPlan.interval === "year" ? t("year") : t("mo")}
              </div>
            </div>

            {/* New Plan */}
            <div className="text-sm">
              <div className="text-neutral-500 dark:text-neutral-400">{t("New plan")}</div>
              <div className="text-neutral-900 dark:text-neutral-100 font-medium">
                ${previewData.newPlan.amount / 100}/{previewData.newPlan.interval === "year" ? t("year") : t("mo")}
              </div>
            </div>

            {previewData.isTrialing ? (
              <div className="text-sm text-neutral-500 dark:text-neutral-400 pt-1">
                {t("Your trial will continue with the new plan. You won't be charged until your trial ends")}
                {previewData.proration.nextBillingDate && (
                  <> {t("on {date}", { date: new Date(previewData.proration.nextBillingDate).toLocaleDateString() })}</>
                )}
                .
              </div>
            ) : (
              <>
                {/* Proration Details */}
                <div className="pt-1">
                  {previewData.proration.charge > 0 && (
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-neutral-500 dark:text-neutral-400">{t("New plan charge (prorated)")}</span>
                      <span className="text-neutral-900 dark:text-neutral-100">
                        ${previewData.proration.charge.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {previewData.proration.credit > 0 && (
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-neutral-500 dark:text-neutral-400">{t("Credit for unused time")}</span>
                      <span className="text-emerald-400">-${previewData.proration.credit.toFixed(2)}</span>
                    </div>
                  )}

                  <div className="flex justify-between text-sm font-medium pt-2">
                    <span className="text-neutral-900 dark:text-neutral-100">{t("Due now")}</span>
                    <span
                      className={
                        previewData.proration.immediatePayment > 0
                          ? "text-neutral-900 dark:text-neutral-100"
                          : "text-emerald-400"
                      }
                    >
                      ${previewData.proration.immediatePayment.toFixed(2)}
                    </span>
                  </div>
                </div>

                {previewData.proration.nextBillingDate && (
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("Your next billing date: {date}", {
                      date: new Date(previewData.proration.nextBillingDate).toLocaleDateString(),
                    })}
                  </div>
                )}
              </>
            )}

            {/* Action Buttons */}
            <div className="flex justify-end gap-3 pt-2">
              <Button onClick={onCancel} disabled={isUpdating} variant="outline">
                {t("Cancel")}
              </Button>
              <Button onClick={onConfirm} disabled={isUpdating} variant="success">
                {isUpdating ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t("Updating…")}
                  </span>
                ) : (
                  t("Confirm Change")
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
