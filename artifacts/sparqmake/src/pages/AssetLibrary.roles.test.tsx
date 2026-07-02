import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/hooks/useAuth";
import { PERMISSION_DENIED_MESSAGE } from "@/lib/utils";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
  toast: (...args: unknown[]) => toastMock(...args),
}));

const brand = { id: "brand-1", name: "Crown U" };

const visualAsset = {
  id: "asset-1",
  brandId: "brand-1",
  type: "visual",
  name: "hero-shot.png",
  description: "A hero shot",
  status: "uploaded",
  fileUrl: null,
  thumbnailUrl: null,
  mimeType: "image/png",
  tags: ["hero"],
  assetClass: null,
  createdAt: "2026-01-15T00:00:00.000Z",
};

const briefAsset = {
  id: "brief-1",
  brandId: "brand-1",
  type: "context",
  name: "Q3 Messaging Brief",
  content: "Talk about the season opener.",
  status: "approved",
  tags: [],
  createdAt: "2026-01-10T00:00:00.000Z",
};

const hashtagSet = {
  id: "hs-1",
  brandId: "brand-1",
  name: "Match Day Base",
  category: "campaign",
  hashtags: ["matchday", "win"],
};

const updateAssetMutate = vi.fn();
const deleteAssetMutate = vi.fn();
const createAssetMutate = vi.fn();
const createHashtagMutate = vi.fn();
const deleteHashtagMutate = vi.fn();

let deleteHashtagOptions: {
  mutation?: { onError?: (err: unknown) => void; onSuccess?: () => void };
} = {};

vi.mock("@workspace/api-client-react", () => ({
  useGetAssets: (params: { type?: string }) => {
    if (params?.type === "visual") {
      return { data: { data: [visualAsset] }, isLoading: false };
    }
    return { data: { data: [briefAsset] }, isLoading: false };
  },
  useGetBrands: () => ({ data: [brand], isLoading: false }),
  useGetHashtagSets: () => ({ data: { data: [hashtagSet] }, isLoading: false }),
  useUpdateAsset: () => ({ mutate: updateAssetMutate, isPending: false }),
  useDeleteAsset: () => ({ mutate: deleteAssetMutate, isPending: false }),
  useCreateAsset: () => ({ mutate: createAssetMutate, isPending: false }),
  useCreateHashtagSet: () => ({ mutate: createHashtagMutate, isPending: false }),
  useUpdateHashtagSet: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteHashtagSet: (options: typeof deleteHashtagOptions) => {
    deleteHashtagOptions = options;
    return { mutate: deleteHashtagMutate, isPending: false };
  },
}));

import AssetLibrary from "./AssetLibrary";

type FetchHandler = (url: string, init?: RequestInit) => Response | undefined;

let extraFetchHandler: FetchHandler | null = null;

function installFetch(role: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            user: {
              id: "u1",
              email: "user@example.com",
              name: "Test User",
              image: null,
              role,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const handled = extraFetchHandler?.(url, init);
      if (handled) return handled;
      if (url.includes("/usage")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderAssetLibrary(role: string) {
  installFetch(role);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AssetLibrary />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function waitForAssetsLoaded() {
  await screen.findByText("hero-shot.png");
}

beforeEach(() => {
  toastMock.mockClear();
  updateAssetMutate.mockClear();
  deleteAssetMutate.mockClear();
  createAssetMutate.mockClear();
  createHashtagMutate.mockClear();
  deleteHashtagMutate.mockClear();
  extraFetchHandler = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssetLibrary as viewer (read-only)", () => {
  it("hides the upload dropzone and asset selection checkboxes", async () => {
    renderAssetLibrary("viewer");
    await waitForAssetsLoaded();
    await waitFor(() => {
      expect(screen.queryByText(/drag & drop files here/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("checkbox", { name: /select hero-shot\.png/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/select all/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no brand assets have been uploaded yet|hero-shot\.png/i)).toBeInTheDocument();
  });

  it("hides edit/approve/archive/delete in the asset detail sheet", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("viewer");
    await waitForAssetsLoaded();
    await user.click(screen.getByText("hero-shot.png"));
    await screen.findByText("Asset Details");
    expect(screen.queryByRole("button", { name: /edit asset/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete asset/i })).not.toBeInTheDocument();
  });

  it("hides brief create/edit/select controls", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("viewer");
    await waitForAssetsLoaded();
    await user.click(screen.getByRole("tab", { name: /briefs & context/i }));
    await screen.findByText("Q3 Messaging Brief");
    expect(screen.queryByRole("button", { name: /create brief/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /select brief/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete selected/i })).not.toBeInTheDocument();
  });

  it("hides hashtag set create/delete controls", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("viewer");
    await waitForAssetsLoaded();
    await user.click(screen.getByRole("tab", { name: /hashtag library/i }));
    await screen.findByText("Match Day Base");
    expect(screen.queryByRole("button", { name: /create hashtag set/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete hashtag set/i })).not.toBeInTheDocument();
  });
});

describe("AssetLibrary as editor (full write UI)", () => {
  it("shows the upload dropzone, selection checkboxes and card write actions", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("editor");
    await waitForAssetsLoaded();
    await screen.findByText(/drag & drop files here/i);
    expect(screen.getByRole("checkbox", { name: /select hero-shot\.png/i })).toBeInTheDocument();

    await user.click(screen.getByText("hero-shot.png"));
    await screen.findByText("Asset Details");
    expect(screen.getByRole("button", { name: /edit asset/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete asset/i })).toBeInTheDocument();
  });

  it("shows brief and hashtag write controls", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("editor");
    await waitForAssetsLoaded();

    await user.click(screen.getByRole("tab", { name: /briefs & context/i }));
    await screen.findByText("Q3 Messaging Brief");
    expect(screen.getByRole("button", { name: /create brief/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /select brief/i })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /hashtag library/i }));
    await screen.findByText("Match Day Base");
    expect(screen.getByRole("button", { name: /create hashtag set/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete hashtag set match day base/i })).toBeInTheDocument();
  });

  it("shows bulk write buttons when assets are selected, and admin sees them too", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("admin");
    await waitForAssetsLoaded();
    await user.click(screen.getByRole("checkbox", { name: /select hero-shot\.png/i }));
    await screen.findByText(/1 selected/i);
    expect(screen.getByRole("button", { name: /approve selected/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archive selected/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tag selected/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete selected/i })).toBeInTheDocument();
  });
});

describe("403 handling surfaces the permission-denied toast", () => {
  it("bulk update rejected with 403 shows the permission toast", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("editor");
    await waitForAssetsLoaded();

    extraFetchHandler = (url) => {
      if (url.includes("/api/assets/bulk-update")) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    };

    await user.click(screen.getByRole("checkbox", { name: /select hero-shot\.png/i }));
    await user.click(await screen.findByRole("button", { name: /approve selected/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: PERMISSION_DENIED_MESSAGE,
        }),
      );
    });
  });

  it("bulk delete rejected with 403 shows the permission toast", async () => {
    const user = userEvent.setup();
    renderAssetLibrary("editor");
    await waitForAssetsLoaded();

    extraFetchHandler = (url) => {
      if (url.includes("/api/assets/bulk-delete")) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    };

    await user.click(screen.getByRole("checkbox", { name: /select hero-shot\.png/i }));
    await user.click(await screen.findByRole("button", { name: /delete selected/i }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: PERMISSION_DENIED_MESSAGE,
        }),
      );
    });
  });

  it("hashtag set deletion failing with an ApiError-style 403 shows the permission toast", async () => {
    const user = userEvent.setup();
    deleteHashtagMutate.mockImplementation(() => {
      deleteHashtagOptions?.mutation?.onError?.({ status: 403 });
    });
    renderAssetLibrary("editor");
    await waitForAssetsLoaded();

    await user.click(screen.getByRole("tab", { name: /hashtag library/i }));
    await screen.findByText("Match Day Base");
    await user.click(screen.getByRole("button", { name: /delete hashtag set match day base/i }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(deleteHashtagMutate).toHaveBeenCalledWith({ id: "hs-1" });
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: PERMISSION_DENIED_MESSAGE,
        }),
      );
    });
  });

  it("asset update failing with an ApiError-style 403 shows the permission toast", async () => {
    const user = userEvent.setup();
    updateAssetMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({ status: 403 });
      },
    );
    renderAssetLibrary("editor");
    await waitForAssetsLoaded();

    await user.click(screen.getByText("hero-shot.png"));
    await screen.findByText("Asset Details");
    await user.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: PERMISSION_DENIED_MESSAGE,
        }),
      );
    });
  });
});
