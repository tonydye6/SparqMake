import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { 
  useGetBrands, 
  useCreateBrand, 
  useUpdateBrand, 
  useDeleteBrand,
  useGetTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useGetSocialAccounts,
  useDeleteSocialAccount,
  useRefreshSocialAccount,
  useGetAssets,
  useUpdateAsset,
  useUploadFile,
  useCreateAsset,
  type Brand,
  type Asset,
  type Template,
  type CreateBrandInput,
  type CreateAssetInput,
  type UpdateAssetInput,
} from "@workspace/api-client-react";

interface TemplateStatsTopRefinementPromptsItem {
  prompt?: string;
  count?: number;
}

interface TemplateStats {
  templateId: string;
  templateName: string;
  totalGenerations: number;
  version: number;
  totalLogs: number;
  approvals: number;
  rejections: number;
  approvalRate?: number | null;
  captionEdits: number;
  headlineEdits: number;
  imageRefinements: number;
  topRefinementPrompts: TemplateStatsTopRefinementPromptsItem[];
}

interface TemplateRecommendationItem {
  field?: string;
  currentValue?: unknown;
  recommendedValue?: unknown;
  reasoning?: string;
  evidenceCount?: number;
}

interface TemplateRecommendation {
  id: string;
  templateId: string;
  analysisData?: Record<string, unknown>;
  recommendations: TemplateRecommendationItem[];
  status: string;
  reviewedAt?: string | null;
  reviewerNotes?: string | null;
  createdAt: string;
}

interface TemplateVersion {
  id: string;
  templateId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedFields?: string[] | null;
  changeReason?: string | null;
  createdAt: string;
}
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { 
  Plus, Save, Hexagon, Shield, Hash, Type, Trash2, Edit2, LayoutTemplate,
  Share2, RefreshCw, Unplug, AlertTriangle, CheckCircle, CheckCircle2, XCircle,
  BarChart3, Sparkles, History, ChevronDown, ChevronUp, Check, X as XIcon,
  Image as ImageIcon, Layers, FileType, Upload, ArrowRight, Clock
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSearch } from "wouter";
import { useDropzone } from "react-dropzone";
import { cn, apiFetch } from "@/lib/utils";
import { useBrandReadiness } from "@/hooks/useBrandReadiness";
import { LayoutSpecEditor } from "@/components/layout-editor";
import { ScheduleProfileEditor } from "@/components/ScheduleProfileEditor";

function FontPreview({ fontId, fileUrl }: { fontId: string; fileUrl: string }) {
  const family = `preview-${fontId}`;
  useEffect(() => {
    let safeUrl: string;
    try {
      safeUrl = new URL(fileUrl, window.location.origin).href;
    } catch {
      return;
    }
    const face = new FontFace(family, `url(${JSON.stringify(safeUrl)})`);
    let cancelled = false;
    face.load()
      .then((loaded) => { if (!cancelled) document.fonts.add(loaded); })
      .catch(() => { /* preview is best-effort */ });
    return () => { cancelled = true; document.fonts.delete(face); };
  }, [family, fileUrl]);

  return (
    <p className="mt-2 text-sm" style={{ fontFamily: family }}>
      The quick brown fox jumps over the lazy dog
    </p>
  );
}

const SETTINGS_SECTIONS = [
  { id: "section-readiness", label: "Brand Readiness" },
  { id: "section-brand-dna", label: "Brand DNA" },
  { id: "section-schedule-profile", label: "Schedule Profile" },
  { id: "section-character-style", label: "Character Style" },
  { id: "section-imagen", label: "Image Generation Settings" },
  { id: "section-platform-rules", label: "Platform Rules" },
  { id: "section-templates", label: "Templates" },
  { id: "section-fonts", label: "Font Management" },
  { id: "section-accounts", label: "Connected Accounts" },
];

export default function Settings() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const initialTab = params.get("tab") === "accounts" ? "accounts" : "brands";
  const [activeSettingsTab, setActiveSettingsTab] = useState(initialTab);

  return (
    <div className="flex flex-col h-full overflow-hidden p-6 max-w-[1200px] mx-auto w-full">
      <div className="mb-6 shrink-0">
        <h1 className="text-3xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your brands and connected social accounts.</p>
      </div>

      <Tabs value={activeSettingsTab} onValueChange={setActiveSettingsTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="bg-card border border-border w-fit rounded-xl p-1 mb-6 flex-shrink-0">
          <TabsTrigger value="brands" className="data-[state=active]:bg-background data-[state=active]:shadow-sm px-6 py-2">
            <Hexagon className="mr-2 h-4 w-4" /> Brand Settings
          </TabsTrigger>
          <TabsTrigger value="accounts" className="data-[state=active]:bg-background data-[state=active]:shadow-sm px-6 py-2">
            <Share2 className="mr-2 h-4 w-4" /> Connected Accounts
          </TabsTrigger>
        </TabsList>

        <TabsContent value="brands" className="flex-1 flex flex-col min-h-0 mt-0">
          <BrandSettingsTab />
        </TabsContent>
        <TabsContent value="accounts" className="flex-1 overflow-y-auto mt-0 pr-4 pb-12">
          <ConnectedAccountsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BrandSettingsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: brands, isLoading } = useGetBrands();
  const [activeBrandId, setActiveBrandId] = useState<string>("");
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);

  useEffect(() => {
    if (brands && brands.length > 0 && !activeBrandId) {
      setActiveBrandId(brands[0].id);
    }
  }, [brands, activeBrandId]);

  const activeBrand = brands?.find(b => b.id === activeBrandId);

  const createBrandMutation = useCreateBrand({
    mutation: {
      onSuccess: (newBrand) => {
        queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
        setIsAddBrandOpen(false);
        setActiveBrandId(newBrand.id);
        toast({ title: "Brand created successfully" });
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ variant: "destructive", title: "Failed to create brand", description: message });
      }
    }
  });

  const onAddBrand = (data: Record<string, string>) => {
    createBrandMutation.mutate({
      data: {
        name: data.name,
        slug: data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        colorPrimary: data.colorPrimary || "#ffffff",
        colorSecondary: data.colorSecondary || "#000000",
        colorAccent: data.colorAccent || "#ff0000",
        colorBackground: data.colorBackground || "#121212",
        voiceDescription: data.voiceDescription || "",
        bannedTerms: [],
        trademarkRules: "",
        hashtagStrategy: {},
        characterStyleRules: "",
        imagenPrefix: "",
        negativePrompt: "",
        platformRules: {
          "twitter": { "char_limit": 280 },
          "instagram_feed": { "char_limit": 2200 },
          "instagram_story": { "char_limit": 2200 },
          "linkedin": { "char_limit": 3000 },
          "tiktok": { "char_limit": 2200 }
        }
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48 bg-card" />
        <Skeleton className="h-12 w-full max-w-2xl bg-card" />
        <Skeleton className="h-[400px] w-full bg-card" />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <p className="text-muted-foreground">Configure brand DNA, rules, and AI parameters.</p>
        </div>
        
        <Dialog open={isAddBrandOpen} onOpenChange={setIsAddBrandOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 shadow-lg shadow-primary/25 text-primary-foreground">
              <Plus className="mr-2 h-4 w-4" /> Add Brand
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create New Brand</DialogTitle>
            </DialogHeader>
            <AddBrandForm onSubmit={onAddBrand} isSubmitting={createBrandMutation.isPending} />
          </DialogContent>
        </Dialog>
      </div>

      {!brands?.length ? (
        <div className="flex-1 flex items-center justify-center border-2 border-dashed border-border rounded-xl">
          <div className="text-center">
            <h3 className="text-lg font-bold mb-2">No Brands Found</h3>
            <p className="text-muted-foreground">Create your first brand to get started.</p>
          </div>
        </div>
      ) : (
        <Tabs value={activeBrandId} onValueChange={setActiveBrandId} className="flex-1 flex flex-col min-h-0">
          <TabsList className="bg-card border border-border w-full justify-start overflow-x-auto rounded-xl p-1 mb-6 flex-shrink-0 hide-scrollbar">
            {brands.map(brand => (
              <TabsTrigger 
                key={brand.id} 
                value={brand.id}
                className="data-[state=active]:bg-background data-[state=active]:shadow-sm px-6 py-2"
              >
                <div className="w-2.5 h-2.5 rounded-full mr-2 shadow-[0_0_8px_currentColor]" style={{ backgroundColor: brand.colorPrimary, color: brand.colorPrimary }} />
                {brand.name}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto mt-0 pr-4 pb-12">
            {activeBrand && <BrandEditor key={activeBrand.id} brand={activeBrand} />}
          </div>
        </Tabs>
      )}
    </>
  );
}

const PLATFORM_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  twitter: { label: "Twitter / X", color: "#1DA1F2", icon: "X" },
  instagram: { label: "Instagram", color: "#E4405F", icon: "IG" },
  linkedin: { label: "LinkedIn", color: "#0A66C2", icon: "in" },
  tiktok: { label: "TikTok", color: "#010101", icon: "TT" },
  youtube: { label: "YouTube", color: "#FF0000", icon: "YT" },
};

const AVAILABLE_PLATFORMS = [
  { id: "twitter", label: "Twitter / X", description: "Post tweets and threads" },
  { id: "instagram", label: "Instagram", description: "Share photos and reels" },
  { id: "linkedin", label: "LinkedIn", description: "Publish professional content" },
  { id: "tiktok", label: "TikTok", description: "Share videos and photo posts" },
  { id: "youtube", label: "YouTube", description: "Upload and publish videos" },
];

function ConnectedAccountsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: accounts, isLoading } = useGetSocialAccounts();
  const { data: brands } = useGetBrands();
  const [connectBrandId, setConnectBrandId] = useState<string>("");
  const baseUrl = import.meta.env.VITE_API_URL || "";

  useEffect(() => {
    if (brands && brands.length > 0 && !connectBrandId) {
      setConnectBrandId(brands[0].id);
    }
  }, [brands, connectBrandId]);

  const deleteMutation = useDeleteSocialAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/social-accounts"] });
        toast({ title: "Account disconnected" });
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ variant: "destructive", title: "Failed to disconnect", description: message });
      }
    }
  });

  const refreshMutation = useRefreshSocialAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/social-accounts"] });
        toast({ title: "Token refreshed successfully" });
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ variant: "destructive", title: "Token refresh failed", description: message });
      }
    }
  });

  const handleConnect = (platform: string) => {
    if (!connectBrandId) {
      toast({ variant: "destructive", title: "Select a brand", description: "Choose which brand to connect this account to." });
      return;
    }
    window.location.href = `${baseUrl}/api/auth/${platform}?brandId=${encodeURIComponent(connectBrandId)}`;
  };

  const brandNameById = new Map((brands || []).map(b => [b.id, b.name]));
  const connectedPlatforms = new Set(
    (accounts || []).filter(a => a.brandId === connectBrandId).map(a => a.platform),
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[200px] w-full bg-card" />
        <Skeleton className="h-[200px] w-full bg-card" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {accounts && accounts.length > 0 && (
        <section className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
            <Share2 className="text-primary" size={20} />
            <h2 className="text-xl font-bold">Connected Accounts</h2>
          </div>
          <div className="space-y-4">
            {accounts.map(account => {
              const config = PLATFORM_CONFIG[account.platform] || { label: account.platform, color: "#666", icon: "?" };
              const status = account.displayStatus || account.status;
              const metadata = (account as unknown as Record<string, unknown>).platformMetadata as Record<string, unknown> | null;
              const subscriberCount = metadata?.subscriberCount as string | undefined;
              return (
                <div key={account.id} className="flex items-center justify-between p-4 border border-border bg-background rounded-lg">
                  <div className="flex items-center gap-4">
                    {(account.profileImageUrl || (account as { avatarUrl?: string | null }).avatarUrl) ? (
                      <img
                        src={account.profileImageUrl || (account as { avatarUrl?: string | null }).avatarUrl || undefined}
                        alt={account.accountName}
                        className="w-10 h-10 rounded-lg object-cover"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                        style={{ backgroundColor: config.color }}
                      >
                        {config.icon}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{account.accountName}</span>
                        <Badge variant="outline" className="text-xs">{config.label}</Badge>
                        {account.brandId && brandNameById.has(account.brandId) && (
                          <Badge variant="secondary" className="text-xs">{brandNameById.get(account.brandId)}</Badge>
                        )}
                        {subscriberCount && (
                          <span className="text-xs text-muted-foreground">
                            {Number(subscriberCount).toLocaleString()} subscribers
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {status === "connected" && (
                          <span className="flex items-center gap-1 text-xs text-green-500">
                            <CheckCircle2 size={12} /> Connected
                          </span>
                        )}
                        {status === "expiring" && (
                          <span className="flex items-center gap-1 text-xs text-amber-500">
                            <AlertTriangle size={12} /> Token expiring soon
                          </span>
                        )}
                        {status === "expired" && (
                          <span className="flex items-center gap-1 text-xs text-red-500">
                            <XCircle size={12} /> Token expired
                          </span>
                        )}
                        {status === "revoked" && (
                          <span className="flex items-center gap-1 text-xs text-red-500">
                            <XCircle size={12} /> Revoked
                          </span>
                        )}
                        {account.tokenExpiry && (
                          <span className="text-xs text-muted-foreground">
                            Expires: {new Date(account.tokenExpiry).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(status === "expiring" || status === "expired") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => refreshMutation.mutate({ id: account.id })}
                        disabled={refreshMutation.isPending}
                      >
                        <RefreshCw className={`h-4 w-4 mr-1 ${refreshMutation.isPending ? "animate-spin" : ""}`} /> Refresh
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        if (confirm(`Disconnect ${account.accountName}?`)) {
                          deleteMutation.mutate({ id: account.id });
                        }
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Unplug className="h-4 w-4 mr-1" /> Disconnect
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6 border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <Plus className="text-primary" size={20} />
            <h2 className="text-xl font-bold">Connect a Platform</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Connect to brand:</span>
            <Select value={connectBrandId} onValueChange={setConnectBrandId}>
              <SelectTrigger className="w-[200px]" data-testid="select-connect-brand">
                <SelectValue placeholder="Select a brand" />
              </SelectTrigger>
              <SelectContent>
                {(brands || []).map(brand => (
                  <SelectItem key={brand.id} value={brand.id}>{brand.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {AVAILABLE_PLATFORMS.map(platform => {
            const config = PLATFORM_CONFIG[platform.id];
            const isConnected = connectedPlatforms.has(platform.id);
            return (
              <div
                key={platform.id}
                className="flex flex-col items-center p-6 border border-border bg-background rounded-lg text-center"
              >
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center text-white font-bold text-lg mb-3"
                  style={{ backgroundColor: config.color }}
                >
                  {config.icon}
                </div>
                <h3 className="font-semibold mb-1">{platform.label}</h3>
                <p className="text-xs text-muted-foreground mb-4">{platform.description}</p>
                <Button
                  variant={isConnected ? "outline" : "default"}
                  size="sm"
                  onClick={() => handleConnect(platform.id)}
                  className={!isConnected ? "bg-primary hover:bg-primary/90" : ""}
                >
                  {isConnected ? "Connect Another" : "Connect"}
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function AddBrandForm({ onSubmit, isSubmitting }: { onSubmit: (data: Record<string, string>) => void, isSubmitting: boolean }) {
  const { register, handleSubmit } = useForm();
  
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Brand Name</label>
        <Input {...register("name", { required: true })} placeholder="e.g. Crown U" />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Voice Description</label>
        <Textarea {...register("voiceDescription")} placeholder="Energetic and professional..." rows={3} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Primary Color</label>
          <div className="flex gap-2">
            <Input type="color" {...register("colorPrimary")} defaultValue="#00A3FF" className="w-12 p-1 h-10" />
            <Input {...register("colorPrimary")} defaultValue="#00A3FF" className="font-mono flex-1" />
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Secondary Color</label>
          <div className="flex gap-2">
            <Input type="color" {...register("colorSecondary")} defaultValue="#1E3A5F" className="w-12 p-1 h-10" />
            <Input {...register("colorSecondary")} defaultValue="#1E3A5F" className="font-mono flex-1" />
          </div>
        </div>
      </div>
      <DialogFooter className="mt-6">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create Brand"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function BrandEditor({ brand }: { brand: Brand }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: brandReadiness } = useBrandReadiness(brand.id);
  const [activeSection, setActiveSection] = useState("section-readiness");

  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    SETTINGS_SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (!el) return;
      const observer = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveSection(id); },
        { threshold: 0.3 }
      );
      observer.observe(el);
      observers.push(observer);
    });
    return () => observers.forEach(o => o.disconnect());
  }, []);

  const brandToFormValues = (b: typeof brand) => ({
    name: b.name,
    slug: b.slug,
    colorPrimary: b.colorPrimary,
    colorSecondary: b.colorSecondary,
    colorAccent: b.colorAccent,
    colorBackground: b.colorBackground,
    voiceDescription: b.voiceDescription || "",
    timezone: ((b as unknown as Record<string, unknown>).timezone as string) || "America/New_York",
    characterStyleRules: b.characterStyleRules || "",
    imagenPrefix: b.imagenPrefix || "",
    negativePrompt: b.negativePrompt || "",
    bannedTerms: b.bannedTerms?.join(", ") || "",
    trademarkRules: b.trademarkRules || "",
    platformRules: JSON.stringify(b.platformRules || {}, null, 2),
    hashtagStrategy: JSON.stringify(b.hashtagStrategy || {}, null, 2),
  });

  const { register, handleSubmit, reset, watch, setValue, formState: { isDirty } } = useForm({
    defaultValues: brandToFormValues(brand),
  });

  const updateBrandMutation = useUpdateBrand({
    mutation: {
      onSuccess: (updated, variables) => {
        queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
        queryClient.invalidateQueries({ queryKey: ["brand-readiness", brand.id] });
        toast({ title: "Brand updated successfully" });
        const merged = (updated && typeof updated === "object" && (updated as { id?: string }).id)
          ? (updated as typeof brand)
          : ({ ...brand, ...(variables.data as Partial<typeof brand>) } as typeof brand);
        reset(brandToFormValues(merged));
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast({ variant: "destructive", title: "Update failed", description: message });
      }
    }
  });

  const deleteBrandMutation = useDeleteBrand({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
        toast({ title: "Brand deleted" });
      }
    }
  });

  const onSubmit = (data: Record<string, string>) => {
    try {
      const parsedPlatformRules = JSON.parse(data.platformRules);
      const parsedHashtagStrategy = JSON.parse(data.hashtagStrategy);
      const bannedTermsArray = data.bannedTerms.split(",").map((s: string) => s.trim()).filter(Boolean);

      updateBrandMutation.mutate({
        id: brand.id,
        data: {
          name: data.name,
          slug: data.slug,
          colorPrimary: data.colorPrimary,
          colorSecondary: data.colorSecondary,
          colorAccent: data.colorAccent,
          colorBackground: data.colorBackground,
          voiceDescription: data.voiceDescription,
          timezone: data.timezone,
          characterStyleRules: data.characterStyleRules,
          imagenPrefix: data.imagenPrefix,
          negativePrompt: data.negativePrompt,
          trademarkRules: data.trademarkRules,
          bannedTerms: bannedTermsArray,
          platformRules: parsedPlatformRules,
          hashtagStrategy: parsedHashtagStrategy,
        } as CreateBrandInput
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      toast({ variant: "destructive", title: "Invalid JSON", description: message });
    }
  };

  const primary = watch("colorPrimary");
  const secondary = watch("colorSecondary");
  const accent = watch("colorAccent");
  const background = watch("colorBackground");

  return (
    <div className="flex gap-8">
      <nav className="sticky top-4 w-48 shrink-0 hidden lg:block space-y-1">
        {SETTINGS_SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            className={`block w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
              activeSection === id
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-w-0">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">

          {/* Unsaved Changes Banner */}
          {isDirty && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2 mb-4 text-sm text-amber-400 flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              You have unsaved changes
            </div>
          )}

          {/* Brand Readiness Indicator */}
          <div id="section-readiness">
            {brandReadiness && (
              <div className={`rounded-lg border p-4 mb-6 ${
                brandReadiness.ready ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5"
              }`}>
                <div className="flex items-center gap-2 mb-3">
                  {brandReadiness.ready ? (
                    <><CheckCircle className="size-4 text-green-500" /><span className="text-sm font-medium text-green-500">Ready for generation</span></>
                  ) : (
                    <><AlertTriangle className="size-4 text-amber-500" /><span className="text-sm font-medium text-amber-500">Setup incomplete</span></>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(brandReadiness.checks).map(([key, check]) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      {check.passed ? (
                        <CheckCircle className="size-3.5 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="size-3.5 text-red-500 shrink-0" />
                      )}
                      <span className={check.passed ? "text-muted-foreground" : "text-foreground"}>
                        {check.label}
                      </span>
                    </div>
                  ))}
                </div>
                {!brandReadiness?.ready && (
                  <a href="/setup" className="inline-flex items-center gap-2 mt-3 text-sm font-medium text-primary hover:underline">
                    Complete Setup <ArrowRight className="h-4 w-4" />
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Visual Identity / Brand DNA */}
          <section id="section-brand-dna" className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6 border-b border-border pb-4">
              <div className="flex items-center gap-2">
                <Hexagon className="text-primary" size={20} />
                <h2 className="text-xl font-bold">Visual Identity</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if(confirm("Are you sure you want to delete this brand?")) {
                      deleteBrandMutation.mutate({ id: brand.id });
                    }
                  }}
                  disabled={deleteBrandMutation.isPending}
                >
                  <Trash2 className="h-4 w-4 mr-2" /> Delete Brand
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <ColorField name="colorPrimary" label="Primary" value={primary} register={register} setValue={setValue} />
              <ColorField name="colorSecondary" label="Secondary" value={secondary} register={register} setValue={setValue} />
              <ColorField name="colorAccent" label="Accent" value={accent} register={register} setValue={setValue} />
              <ColorField name="colorBackground" label="Background" value={background} register={register} setValue={setValue} />
            </div>

            <div className="space-y-6 mt-6">
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Voice Description</label>
                <Textarea {...register("voiceDescription")} className="font-mono text-sm bg-background border-border min-h-[120px]" />
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Timezone</label>
                <p className="text-xs text-muted-foreground mb-2">Used for Smart Schedule to determine optimal posting times in your audience's timezone.</p>
                <select
                  {...register("timezone")}
                  className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="America/New_York">Eastern Time (ET)</option>
                  <option value="America/Chicago">Central Time (CT)</option>
                  <option value="America/Denver">Mountain Time (MT)</option>
                  <option value="America/Los_Angeles">Pacific Time (PT)</option>
                  <option value="America/Anchorage">Alaska Time (AKT)</option>
                  <option value="Pacific/Honolulu">Hawaii Time (HT)</option>
                  <option value="Europe/London">GMT / London</option>
                  <option value="Europe/Paris">Central European (CET)</option>
                  <option value="Europe/Berlin">Central European (CET)</option>
                  <option value="Asia/Tokyo">Japan (JST)</option>
                  <option value="Asia/Shanghai">China (CST)</option>
                  <option value="Asia/Kolkata">India (IST)</option>
                  <option value="Australia/Sydney">Sydney (AEST)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
            </div>
          </section>

          <BrandAssetGroups brandId={brand.id} />

          {/* Schedule Profile */}
          <section id="section-schedule-profile" className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <Clock className="text-primary" size={20} />
              <h2 className="text-xl font-bold">Schedule Profile</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Define optimal posting windows per platform. Click cells to cycle between preferred, acceptable, and blocked. Use "Generate AI Profile" to auto-populate based on platform best practices.
            </p>
            <ScheduleProfileEditor
              brandId={brand.id}
              timezone={watch("timezone") || "America/New_York"}
            />
          </section>

          {/* Character Style Rules */}
          <section id="section-character-style" className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <Type className="text-primary" size={20} />
              <h2 className="text-xl font-bold">Character Style Rules</h2>
            </div>

            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">Style Mandates</label>
              <p className="text-xs text-muted-foreground mb-2">These rules are automatically injected into every image generation prompt for this brand to enforce consistent character stylization.</p>
              <Textarea {...register("characterStyleRules")} className="font-mono text-sm bg-background border-border h-32" placeholder='e.g. "All characters must match the stylized 3D game art style seen in the reference images. They must appear to be from the same game."' />
            </div>
          </section>

          {/* Imagen Config */}
          <section id="section-imagen" className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <Type className="text-primary" size={20} />
              <h2 className="text-xl font-bold">Image Generation Settings</h2>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Default Style Instructions</label>
                <Textarea {...register("imagenPrefix")} className="font-mono text-sm bg-background border-border h-24" />
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Avoid List</label>
                <Textarea {...register("negativePrompt")} className="font-mono text-sm bg-background border-border h-24" />
              </div>
            </div>
          </section>

          {/* Platform Rules */}
          <section id="section-platform-rules" className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <Shield className="text-primary" size={20} />
              <h2 className="text-xl font-bold">Brand Safety & Rules</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Banned Terms (Comma separated)</label>
                <Textarea {...register("bannedTerms")} className="bg-background border-border min-h-[100px]" />
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Trademark Rules</label>
                <Textarea {...register("trademarkRules")} className="bg-background border-border min-h-[100px]" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Platform Rules (JSON)</label>
                <Textarea {...register("platformRules")} className="font-mono text-sm bg-background border-border min-h-[200px]" />
              </div>
              <div>
                <label className="text-sm font-semibold text-foreground mb-2 block">Hashtag Strategy (JSON)</label>
                <Textarea {...register("hashtagStrategy")} className="font-mono text-sm bg-background border-border min-h-[200px]" />
              </div>
            </div>
          </section>

          {/* Templates */}
          <section id="section-templates" className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <LayoutTemplate className="text-primary" size={20} />
              <h2 className="text-xl font-bold">Templates</h2>
            </div>
            <BrandTemplates
              brandId={brand.id}
              brandColors={{
                primary: brand.colorPrimary || "#3b82f6",
                secondary: brand.colorSecondary || "#64748b",
                accent: brand.colorAccent || "#f59e0b",
                background: brand.colorBackground || "#0f172a",
              }}
            />
          </section>

          {/* Font Management */}
          <div id="section-fonts">
            <BrandFontManagement brandId={brand.id} />
          </div>

          {/* Connected Accounts anchor for section nav */}
          <div id="section-accounts" />

          <div className="flex justify-end pt-4 pb-8">
            <Button type="submit" disabled={updateBrandMutation.isPending} className="bg-primary hover:bg-primary/90 font-bold px-8 shadow-lg shadow-primary/25">
              <Save className="mr-2" size={18} />
              {updateBrandMutation.isPending ? "Saving..." : "Save Brand Changes"}
            </Button>
          </div>

        </form>
      </div>
    </div>
  );
}

const BRAND_ASSET_GROUPS = [
  { key: "logos", label: "Logos & Marks", assetClass: "compositing", role: null, description: "Primary and secondary logos for compositing", nameHints: ["logo", "icon", "mark", "wordmark", "badge"] },
  { key: "characters", label: "Character References", assetClass: "subject_reference", role: "primary_subject", description: "Character images for AI generation", nameHints: ["char_", "_char", "character"] },
  { key: "styles", label: "Style Plates & Backgrounds", assetClass: "style_reference", role: null, description: "Mood boards, textures, and backgrounds", nameHints: ["bg_", "background", "plate", "style", "texture", "mood"] },
  { key: "gameplay", label: "Gameplay References", assetClass: "subject_reference", role: "supporting", description: "In-game screenshots and action shots", nameHints: ["screenshot", "gameplay", "ref_screenshot"] },
  { key: "partner", label: "Partner / Compliance Marks", assetClass: "compositing", role: "overlay", description: "Sponsor logos and compliance marks", nameHints: ["partner", "sponsor", "compliance"] },
];

function BrandAssetGroups({ brandId }: { brandId: string }) {
  const { data: allAssets } = useGetAssets({ brandId, limit: 200 });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateAsset();
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState<string | null>(null);

  const getGroupAssets = (group: typeof BRAND_ASSET_GROUPS[0]) => {
    if (!allAssets?.data) return [];
    return allAssets.data.filter(a => {
      if (a.assetClass !== group.assetClass) return false;
      if (group.role && a.generationRole !== group.role) return false;
      return true;
    });
  };

  const getAvailableVisuals = (group: typeof BRAND_ASSET_GROUPS[0]) => {
    if (!allAssets?.data) return [];
    const groupAssetIds = new Set(getGroupAssets(group).map(a => a.id));
    const hints = group.nameHints || [];
    return allAssets.data.filter(a => {
      if (a.type !== "visual" || groupAssetIds.has(a.id)) return false;
      if (hints.length === 0) return true;
      const name = (a.name || "").toLowerCase();
      return hints.some(h => name.includes(h));
    });
  };

  const assignToGroup = (assetId: string, group: typeof BRAND_ASSET_GROUPS[0]) => {
    updateMutation.mutate({ id: assetId, data: {
      assetClass: group.assetClass,
      generationRole: group.role || undefined,
    }}, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        toast({ title: "Asset assigned to group" });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to assign asset" });
      }
    });
  };

  const removeFromGroup = (assetId: string) => {
    updateMutation.mutate({ id: assetId, data: {
      assetClass: null,
      generationRole: null,
    }}, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        toast({ title: "Asset removed from group" });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to remove asset" });
      }
    });
  };

  return (
    <section className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
        <Layers className="text-primary" size={20} />
        <h2 className="text-xl font-bold">Brand Assets</h2>
      </div>

      <div className="space-y-3">
        {BRAND_ASSET_GROUPS.map(group => {
          const assets = getGroupAssets(group);
          const isExpanded = expandedGroup === group.key;
          return (
            <div key={group.key} className="border border-border rounded-lg overflow-hidden bg-background">
              <button
                className="w-full p-4 flex items-center justify-between hover:bg-muted/30 transition-colors"
                onClick={() => setExpandedGroup(isExpanded ? null : group.key)}
              >
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-sm">{group.label}</span>
                  <Badge variant="outline" className="text-[10px]">{assets.length}</Badge>
                </div>
                {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground mb-3">{group.description}</p>
                  {assets.length > 0 ? (
                    <div className="grid grid-cols-4 gap-2 mb-3">
                      {assets.map(asset => (
                        <div key={asset.id} className="relative group aspect-square rounded-md overflow-hidden border border-border bg-muted/30">
                          {asset.thumbnailUrl || asset.fileUrl ? (
                            <img src={asset.thumbnailUrl || asset.fileUrl || ""} alt={asset.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center"><ImageIcon size={16} className="text-muted-foreground" /></div>
                          )}
                          <button
                            onClick={() => removeFromGroup(asset.id)}
                            className="absolute top-1 right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <XIcon size={10} className="text-white" />
                          </button>
                          <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                            <p className="text-[9px] text-white truncate">{asset.name}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground italic mb-3">No assets in this group yet.</p>
                  )}
                  <Dialog open={addDialogOpen === group.key} onOpenChange={(v) => setAddDialogOpen(v ? group.key : null)}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm"><Plus className="w-3.5 h-3.5 mr-1" /> Add Asset</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-3xl w-[90vw]">
                      <DialogHeader><DialogTitle>Add to {group.label}</DialogTitle></DialogHeader>
                      <div className="max-h-[60vh] overflow-y-auto pt-4 pr-1">
                        <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-3">
                          {getAvailableVisuals(group).map(asset => (
                            <button
                              key={asset.id}
                              onClick={() => { assignToGroup(asset.id, group); setAddDialogOpen(null); }}
                              className="relative w-full rounded-md border-2 border-border bg-muted/30 hover:border-primary transition-colors overflow-hidden"
                              style={{ paddingBottom: "100%" }}
                            >
                              {asset.thumbnailUrl || asset.fileUrl ? (
                                <img src={asset.thumbnailUrl || asset.fileUrl || ""} alt={asset.name} className="absolute inset-0 w-full h-full object-cover" />
                              ) : (
                                <div className="absolute inset-0 flex items-center justify-center"><ImageIcon size={16} className="text-muted-foreground" /></div>
                              )}
                            </button>
                          ))}
                          {getAvailableVisuals(group).length === 0 && (
                            <p className="col-span-6 text-center text-sm text-muted-foreground py-8">No matching visual assets found.</p>
                          )}
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BrandFontManagement({ brandId }: { brandId: string }) {
  const apiBase = import.meta.env.VITE_API_URL || "";
  const { data: allAssets } = useGetAssets({ brandId, type: "font" });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const uploadMutation = useUploadFile();
  const createAssetMutation = useCreateAsset();
  const updateMutation = useUpdateAsset();

  const fontAssets = allAssets?.data || [];

  const [editingFont, setEditingFont] = useState<string | null>(null);
  const [fontNameEdit, setFontNameEdit] = useState("");
  const [fontWeightEdit, setFontWeightEdit] = useState("");

  const onDrop = useCallback((files: File[]) => {
    files.forEach(file => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (!['woff2', 'ttf', 'otf'].includes(ext || '')) {
        toast({ variant: "destructive", title: "Invalid font file", description: "Only .woff2, .ttf, and .otf files are supported." });
        return;
      }

      uploadMutation.mutate({ data: { file, type: 'font', brandId } }, {
        onSuccess: (res) => {
          createAssetMutation.mutate({
            data: {
              brandId,
              type: "font",
              name: file.name.replace(/\.[^.]+$/, ''),
              status: "approved",
              fileUrl: res.url,
              mimeType: file.type || `font/${ext}`,
              fileSizeBytes: file.size,
              tags: [],
              fontName: file.name.replace(/\.[^.]+$/, ''),
              fontWeight: "400",
            } as unknown as CreateAssetInput
          }, {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
              toast({ title: "Font uploaded", description: file.name });
            }
          });
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          toast({ variant: "destructive", title: "Upload failed", description: message });
        }
      });
    });
  }, [uploadMutation, createAssetMutation, brandId, toast, queryClient]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'font/woff2': ['.woff2'], 'font/ttf': ['.ttf'], 'font/otf': ['.otf'], 'application/x-font-ttf': ['.ttf'], 'application/x-font-opentype': ['.otf'] }
  });

  const saveFontEdit = (assetId: string) => {
    updateMutation.mutate({ id: assetId, data: { name: fontNameEdit, fontName: fontNameEdit, fontWeight: fontWeightEdit } as UpdateAssetInput }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        setEditingFont(null);
        toast({ title: "Font updated" });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to update font" });
      }
    });
  };

  const deleteFont = async (assetId: string) => {
    if (!confirm("Delete this font?")) return;
    try {
      const res = await apiFetch(`${apiBase}/api/assets/${assetId}`, { method: "DELETE" });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
        toast({ title: "Font deleted" });
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to delete font" });
    }
  };

  return (
    <section className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
        <FileType className="text-primary" size={20} />
        <h2 className="text-xl font-bold">Font Management</h2>
      </div>

      <div
        {...getRootProps()}
        className={cn(
          "mb-6 border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
          isDragActive ? "border-primary bg-primary/5" : "border-border bg-background hover:border-primary/50"
        )}
      >
        <input {...getInputProps()} />
        <Upload size={20} className="text-primary mx-auto mb-2" />
        <p className="text-sm font-medium">{uploadMutation.isPending ? "Uploading..." : "Drop font files here"}</p>
        <p className="text-xs text-muted-foreground">.woff2, .ttf, .otf</p>
      </div>

      {fontAssets.length > 0 ? (
        <div className="space-y-3">
          {fontAssets.map(font => {
            const isEditing = editingFont === font.id;
            return (
              <div key={font.id} className="flex items-center gap-4 p-4 border border-border bg-background rounded-lg">
                <div className="w-10 h-10 bg-muted rounded flex items-center justify-center shrink-0">
                  <FileType size={20} className="text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex gap-2 items-center">
                      <Input
                        value={fontNameEdit}
                        onChange={e => setFontNameEdit(e.target.value)}
                        className="h-8 text-sm flex-1"
                        placeholder="Font name"
                      />
                      <Input
                        value={fontWeightEdit}
                        onChange={e => setFontWeightEdit(e.target.value)}
                        className="h-8 text-sm w-20"
                        placeholder="Weight"
                      />
                      <Button size="sm" className="h-8" onClick={() => saveFontEdit(font.id)}>Save</Button>
                      <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditingFont(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <>
                      <p className="font-semibold text-sm truncate">{(font as any).fontName || font.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">Weight: {(font as any).fontWeight || "400"}</Badge>
                        <span className="text-[10px] text-muted-foreground">{font.mimeType}</span>
                        {font.fileSizeBytes && (
                          <span className="text-[10px] text-muted-foreground">{(font.fileSizeBytes / 1024).toFixed(0)} KB</span>
                        )}
                      </div>
                      {font.fileUrl && <FontPreview fontId={font.id} fileUrl={font.fileUrl} />}
                    </>
                  )}
                </div>
                {!isEditing && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingFont(font.id); setFontNameEdit((font as any).fontName || font.name); setFontWeightEdit((font as any).fontWeight || "400"); }}>
                      <Edit2 size={14} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => deleteFont(font.id)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-4">No fonts uploaded yet. Upload .woff2, .ttf, or .otf files to use in compositing.</p>
      )}
    </section>
  );
}

interface ColorFieldProps {
  name: string;
  label: string;
  value: string;
  register: import("react-hook-form").UseFormRegister<any>;
  setValue: import("react-hook-form").UseFormSetValue<any>;
}

function ColorField({ name, label, value, register, setValue }: ColorFieldProps) {
  return (
    <div>
      <label className="text-xs font-semibold text-muted-foreground uppercase mb-2 block">{label}</label>
      <div className="flex gap-2 items-center">
        <div className="relative w-10 h-10 rounded shadow-inner border border-border overflow-hidden">
          <input 
            type="color" 
            value={value || "#000000"} 
            onChange={(e) => setValue(name, e.target.value, { shouldDirty: true })}
            className="absolute -inset-2 w-16 h-16 cursor-pointer"
          />
        </div>
        <Input {...register(name)} className="font-mono bg-background border-border" />
      </div>
    </div>
  );
}


function BrandTemplates({ brandId, brandColors, brandLogoUrl }: {
  brandId: string;
  brandColors?: { primary: string; secondary: string; accent: string; background: string };
  brandLogoUrl?: string | null;
}) {
  const { data: templates } = useGetTemplates({ brandId });
  const [isAddOpen, setIsAddOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createTemplateMutation = useCreateTemplate({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
        setIsAddOpen(false);
        toast({ title: "Template added" });
      }
    }
  });

  const deleteTemplateMutation = useDeleteTemplate({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
        toast({ title: "Template deleted" });
      }
    }
  });

  const { register, handleSubmit, reset, watch, setValue } = useForm();

  const onAddTemplate = (data: Record<string, string>) => {
    try {
      const claudeInst = data.claudeCaptionInstruction ? JSON.parse(data.claudeCaptionInstruction) : {};
      const rawLayout = data.layoutSpec;
      // layoutSpec may already be a parsed object (from LayoutSpecEditor via JSON.stringify)
      // or null/undefined/"null"/empty string
      let layoutSpc: Record<string, unknown> | null = null;
      if (rawLayout && rawLayout !== "null" && rawLayout !== "{}") {
        layoutSpc = typeof rawLayout === "object" ? rawLayout : JSON.parse(rawLayout);
      }
      
      createTemplateMutation.mutate({
        data: {
          brandId,
          name: data.name,
          description: data.description,
          imagenPromptAddition: data.imagenPromptAddition || "",
          imagenNegativeAddition: data.imagenNegativeAddition || "",
          claudeCaptionInstruction: claudeInst,
          claudeHeadlineInstruction: data.claudeHeadlineInstruction,
          layoutSpec: layoutSpc,
          recommendedAssetTypes: data.recommendedAssetTypes ? data.recommendedAssetTypes.split(",").map((s:string) => s.trim()) : ["image"],
          targetAspectRatios: data.targetAspectRatios ? data.targetAspectRatios.split(",").map((s:string) => s.trim()) : ["1:1"]
        }
      });
    } catch {
      toast({ variant: "destructive", title: "JSON Parse Error", description: "Ensure instructions and layout specs are valid JSON." });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">Manage templates for content generation.</p>
        <Dialog open={isAddOpen} onOpenChange={(v) => { setIsAddOpen(v); if(!v) reset(); }}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm"><Plus className="h-4 w-4 mr-2" /> Add Template</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add Template</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit(onAddTemplate)} className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input {...register("name", { required: true })} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description</label>
                  <Input {...register("description")} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Imagen Prompt Additions</label>
                  <Textarea {...register("imagenPromptAddition")} rows={2} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Imagen Negative Additions</label>
                  <Textarea {...register("imagenNegativeAddition")} rows={2} />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Claude Caption Instruction (JSON)</label>
                <Textarea {...register("claudeCaptionInstruction")} defaultValue="{}" className="font-mono text-sm" rows={4} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Layout Template</label>
                <input type="hidden" {...register("layoutSpec")} />
                <LayoutSpecEditor
                  value={(() => {
                    try {
                      const raw = watch("layoutSpec");
                      if (!raw || raw === "null" || raw === "{}") return {};
                      return typeof raw === "object" ? raw : JSON.parse(raw);
                    } catch {
                      return {};
                    }
                  })()}
                  onChange={(newSpec) =>
                    setValue("layoutSpec", JSON.stringify(newSpec), { shouldDirty: true })
                  }
                  brandColors={brandColors}
                  brandLogoUrl={brandLogoUrl}
                  targetAspectRatios={
                    watch("targetAspectRatios")
                      ?.split?.(",")
                      ?.map((s: string) => s.trim())
                      .filter(Boolean) || []
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Recommended Asset Types (comma separated)</label>
                  <Input {...register("recommendedAssetTypes")} defaultValue="image, video" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Target Aspect Ratios (comma separated)</label>
                  <Input {...register("targetAspectRatios")} defaultValue="1:1, 16:9, 9:16" />
                </div>
              </div>
              <DialogFooter className="mt-4">
                <Button type="submit" disabled={createTemplateMutation.isPending}>Save Template</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-4">
        {templates?.data?.map(t => (
          <TemplateCard key={t.id} template={t} onDelete={() => {
            if (confirm("Delete template?")) {
              deleteTemplateMutation.mutate({ id: t.id });
            }
          }} />
        ))}
        {templates?.data?.length === 0 && <p className="text-sm text-muted-foreground italic">No templates configured.</p>}
      </div>
    </div>
  );
}

function TemplateCard({ template, onDelete }: { template: Template; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const apiBase = import.meta.env.VITE_API_URL || "";
  const queryClient = useQueryClient();

  const [stats, setStats] = useState<TemplateStats | null>(null);
  const [recommendations, setRecommendations] = useState<TemplateRecommendation[]>([]);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [activePanel, setActivePanel] = useState<"stats" | "recommendations" | "versions">("stats");

  const loadDetails = async () => {
    try {
      const [statsRes, recsRes, versRes] = await Promise.all([
        apiFetch(`${apiBase}/api/templates/${template.id}/stats`),
        apiFetch(`${apiBase}/api/templates/${template.id}/recommendations`),
        apiFetch(`${apiBase}/api/templates/${template.id}/versions`),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (recsRes.ok) setRecommendations(await recsRes.json());
      if (versRes.ok) setVersions(await versRes.json());
    } catch {
      toast({ variant: "destructive", title: "Failed to load template details" });
    }
  };

  useEffect(() => {
    if (expanded) loadDetails();
  }, [expanded]);

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    try {
      const res = await apiFetch(`${apiBase}/api/templates/${template.id}/analyze`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        toast({ variant: "destructive", title: "Analysis failed", description: err.error });
      } else {
        toast({ title: "Analysis complete" });
        loadDetails();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      toast({ variant: "destructive", title: "Analysis failed", description: msg });
    }
    setIsAnalyzing(false);
  };

  const handleRecommendationAction = async (recId: string, action: "apply" | "dismiss") => {
    try {
      const res = await apiFetch(`${apiBase}/api/templates/${template.id}/recommendations/${recId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast({ title: action === "apply" ? "Recommendation applied" : "Recommendation dismissed" });
        loadDetails();
        queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
      }
    } catch {
      toast({ variant: "destructive", title: `Failed to ${action} recommendation` });
    }
  };

  const handleRollback = async (versionId: string) => {
    try {
      const res = await apiFetch(`${apiBase}/api/templates/${template.id}/rollback/${versionId}`, { method: "POST" });
      if (res.ok) {
        toast({ title: "Template restored to previous version" });
        loadDetails();
        queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to restore template version" });
    }
  };

  return (
    <div className="border border-border bg-background rounded-lg overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-bold">{template.name}</h4>
              <Badge variant="outline" className="text-[10px]">v{template.version || 1}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{template.description || "No description"}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {template.targetAspectRatios?.map((r: string) => <Badge key={r} variant="secondary" className="text-[10px]">{r}</Badge>)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 pb-4">
          <div className="flex gap-2 mt-3 mb-4">
            <Button variant={activePanel === "stats" ? "default" : "outline"} size="sm" onClick={() => setActivePanel("stats")}>
              <BarChart3 className="h-3.5 w-3.5 mr-1" /> Stats
            </Button>
            <Button variant={activePanel === "recommendations" ? "default" : "outline"} size="sm" onClick={() => setActivePanel("recommendations")}>
              <Sparkles className="h-3.5 w-3.5 mr-1" /> Recommendations
            </Button>
            <Button variant={activePanel === "versions" ? "default" : "outline"} size="sm" onClick={() => setActivePanel("versions")}>
              <History className="h-3.5 w-3.5 mr-1" /> Version History
            </Button>
          </div>

          {activePanel === "stats" && stats && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="Generations" value={stats.totalGenerations} />
                <StatCard label="Approval Rate" value={stats.approvalRate != null ? `${(stats.approvalRate * 100).toFixed(0)}%` : "N/A"} />
                <StatCard label="Caption Edits" value={stats.captionEdits} />
                <StatCard label="Image Refinements" value={stats.imageRefinements} />
              </div>
              {stats.topRefinementPrompts?.length > 0 && (
                <div>
                  <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Top Refinement Prompts</h5>
                  <div className="space-y-1">
                    {stats.topRefinementPrompts.slice(0, 5).map((p: { prompt?: string; count?: number }, i: number) => (
                      <div key={i} className="flex justify-between text-sm px-3 py-1.5 bg-card rounded">
                        <span className="text-foreground truncate mr-4">"{p.prompt}"</span>
                        <span className="text-muted-foreground shrink-0">{p.count}x</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <Button variant="outline" size="sm" onClick={handleAnalyze} disabled={isAnalyzing}>
                <Sparkles className={`h-4 w-4 mr-2 ${isAnalyzing ? "animate-spin" : ""}`} />
                {isAnalyzing ? "Analyzing..." : "Run AI Analysis"}
              </Button>
            </div>
          )}
          {activePanel === "stats" && !stats && (
            <p className="text-sm text-muted-foreground">Loading stats...</p>
          )}

          {activePanel === "recommendations" && (
            <div className="space-y-3">
              {recommendations.length === 0 ? (
                <div className="text-center py-6">
                  <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No recommendations yet. Run AI analysis from the Stats tab to generate them.</p>
                </div>
              ) : (
                recommendations.map((rec: TemplateRecommendation) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    onApply={() => handleRecommendationAction(rec.id, "apply")}
                    onDismiss={() => handleRecommendationAction(rec.id, "dismiss")}
                  />
                ))
              )}
            </div>
          )}

          {activePanel === "versions" && (
            <div className="space-y-2">
              {versions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No version history yet. Changes will be tracked automatically.</p>
              ) : (
                versions.map((v: TemplateVersion) => (
                  <div key={v.id} className="flex items-center justify-between p-3 bg-card rounded-lg border border-border">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">Version {v.version}</span>
                        <span className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleDateString()}</span>
                      </div>
                      {v.changeReason && <p className="text-xs text-muted-foreground mt-0.5">{v.changeReason}</p>}
                      {(v.changedFields?.length ?? 0) > 0 && (
                        <div className="flex gap-1 mt-1">
                          {v.changedFields?.map((f: string) => <Badge key={f} variant="outline" className="text-[10px]">{f}</Badge>)}
                        </div>
                      )}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => handleRollback(v.id)}>
                      <History className="h-3.5 w-3.5 mr-1" /> Restore
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-center">
      <div className="text-lg font-bold text-foreground">{value}</div>
      <div className="text-[10px] uppercase text-muted-foreground font-semibold tracking-wider">{label}</div>
    </div>
  );
}

function RecommendationCard({ rec, onApply, onDismiss }: { rec: TemplateRecommendation; onApply: () => void; onDismiss: () => void }) {
  const isActionable = rec.status === "pending";
  const recs = rec.recommendations || [];

  return (
    <div className={`border rounded-lg p-4 ${rec.status === "applied" ? "border-green-500/30 bg-green-500/5" : rec.status === "dismissed" ? "border-border bg-card/50 opacity-60" : "border-border bg-card"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Badge variant={rec.status === "applied" ? "default" : rec.status === "dismissed" ? "secondary" : "outline"} className="text-[10px]">
            {rec.status}
          </Badge>
          <span className="text-xs text-muted-foreground">{new Date(rec.createdAt).toLocaleDateString()}</span>
        </div>
        {isActionable && (
          <div className="flex gap-1">
            <Button variant="default" size="sm" onClick={onApply} className="h-7 text-xs bg-green-600 hover:bg-green-700">
              <Check className="h-3 w-3 mr-1" /> Apply All
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss} className="h-7 text-xs text-muted-foreground">
              <XIcon className="h-3 w-3 mr-1" /> Dismiss
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {recs.map((r: TemplateRecommendationItem, i: number) => (
          <div key={i} className="bg-background rounded p-3 border border-border">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-[10px] font-mono">{r.field}</Badge>
              {r.evidenceCount && <span className="text-[10px] text-muted-foreground">{r.evidenceCount} data points</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
              <div>
                <span className="text-muted-foreground block mb-0.5">Current</span>
                <div className="font-mono bg-card p-2 rounded border border-border text-foreground/70 whitespace-pre-wrap max-h-24 overflow-y-auto">
                  {typeof r.currentValue === "string" ? r.currentValue || "(empty)" : JSON.stringify(r.currentValue, null, 2)}
                </div>
              </div>
              <div>
                <span className="text-green-500 block mb-0.5">Recommended</span>
                <div className="font-mono bg-card p-2 rounded border border-green-500/30 text-foreground whitespace-pre-wrap max-h-24 overflow-y-auto">
                  {typeof r.recommendedValue === "string" ? r.recommendedValue : JSON.stringify(r.recommendedValue, null, 2)}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 italic">{r.reasoning}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
