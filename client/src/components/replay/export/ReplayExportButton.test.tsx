import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplayExportStatus } from "@/api/analytics/endpoints/sessionReplay";

const mocks = vi.hoisted(() => ({
  site: "2",
  create: vi.fn(),
  download: vi.fn(),
  status: vi.fn(),
  downloadBlob: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ site: mocks.site }) }));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/api/analytics/hooks/sessionReplay/useReplayExport", () => ({
  useCreateReplayExport: () => ({ mutateAsync: mocks.create, isPending: false }),
  useDownloadReplayExport: () => ({ mutateAsync: mocks.download, isPending: false }),
  useReplayExportStatus: mocks.status,
}));
vi.mock("@/lib/export", () => ({ downloadBlob: mocks.downloadBlob }));
vi.mock("@/components/ui/sonner", () => ({ toast: mocks.toast }));

import { ReplayExportButton } from "./ReplayExportButton";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.site = "2";
  mocks.create.mockResolvedValue({ exportId: "original-export" });
  mocks.download.mockResolvedValue(new Blob(["export"]));
  mocks.status.mockReturnValue({ data: undefined });
});
afterEach(cleanup);

describe("ReplayExportButton request identity", () => {
  it("keeps polling and downloading the original recording after selection changes", async () => {
    const view = render(<ReplayExportButton sessionId="original" range={[0, 1000]} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.status).toHaveBeenLastCalledWith(2, "original", "original-export"));

    mocks.site = "3";
    view.rerender(<ReplayExportButton sessionId="replacement" range={[2000, 3000]} />);
    expect(mocks.status).toHaveBeenLastCalledWith(2, "original", "original-export");

    const ready: ReplayExportStatus = { exportId: "original-export", state: "ready", progress: 100 };
    mocks.status.mockReturnValue({ data: ready });
    view.rerender(<ReplayExportButton sessionId="replacement" range={[2000, 3000]} />);
    await waitFor(() => {
      expect(mocks.download).toHaveBeenCalledExactlyOnceWith({
        siteId: 2,
        sessionId: "original",
        exportId: "original-export",
      });
    });
    expect(mocks.downloadBlob).toHaveBeenCalledWith("rybbit-export-original.zip", expect.any(Blob));
  });

  it("keeps a delayed create response bound to the selection that started it", async () => {
    let resolveCreate!: (result: { exportId: string }) => void;
    mocks.create.mockReturnValue(new Promise<{ exportId: string }>(resolve => (resolveCreate = resolve)));
    const view = render(<ReplayExportButton sessionId="original" range={[0, 1000]} />);
    fireEvent.click(screen.getByRole("button"));
    mocks.site = "3";
    view.rerender(<ReplayExportButton sessionId="replacement" range={[2000, 3000]} />);

    await act(async () => resolveCreate({ exportId: "original-export" }));
    expect(mocks.status).toHaveBeenLastCalledWith(2, "original", "original-export");
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      siteId: 2,
      sessionId: "original",
      options: { startMs: 0, endMs: 1000 },
    });
  });
});
