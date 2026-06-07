import { apiFetch } from "@/lib/utils";
import { useState, useCallback, useRef, useEffect } from "react";
import { VariantGrid } from "@/components/creative-studio/VariantGrid";
import { CreativeConfigPanel } from "@/components/creative-studio/CreativeConfigPanel";
import {
  useGetBrands,
  useGetTemplates,
  useGetAssets,
  useCreateCreative,
  getGetTemplatesQueryKey,
  getGetAssetsQueryKey,
  type Asset,
  type Template,
  type CreateCreativeInput,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ScheduleModal } from "@/components/ScheduleModal";
import { SmartScheduleModal } from "@/components/SmartScheduleModal";
import { useSearch } from "wouter";
import { HashtagSetDialog } from "@/components/creative-studio/HashtagSetDialog";
import { AudioSettingsDialog } from "@/components/creative-studio/AudioSettingsDialog";
import { ActivityPanel } from "@/components/creative-studio/ActivityPanel";
import { CreativeStudioSkeleton } from "@/components/creative-studio/CreativeStudioSkeleton";
import { useBrandReadiness } from "@/hooks/useBrandReadiness";
import { GeneratedVariant, ActivityLog, DuplicateInfo, BudgetStatus, RewriteToolbarState, LoadingPhase, PLATFORM_LABELS, ALL_PLATFORM_KEYS, PLAN_PLATFORM_MAP, API_BASE } from "@/components/creative-studio/creative-studio.types";

export default function CreativeStudio() {
  const { toast } = useToast();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const remixId = params.get("remix");
  const fromPlanCreativeId = params.get("campaign");
  const fromPlanPlatform = params.get("platform");
  
  const { data: brands } = useGetBrands();
  const [selectedBrand, setSelectedBrand] = useState<string>("");
  
  const { data: templates } = useGetTemplates({ brandId: selectedBrand || undefined }, { query: { enabled: !!selectedBrand, queryKey: getGetTemplatesQueryKey({ brandId: selectedBrand || undefined }) } });
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");

  const { data: approvedAssets } = useGetAssets({ brandId: selectedBrand || undefined, status: "approved" }, { query: { enabled: !!selectedBrand, queryKey: getGetAssetsQueryKey({ brandId: selectedBrand || undefined, status: "approved" }) } });
  const { data: briefs } = useGetAssets({ brandId: selectedBrand || undefined, type: "context" }, { query: { enabled: !!selectedBrand, queryKey: getGetAssetsQueryKey({ brandId: selectedBrand || undefined, type: "context" }) } });

  const [creativeName, setCreativeName] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [briefText, setBriefText] = useState("");
  const [refineText, setRefineText] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(ALL_PLATFORM_KEYS);
  
  const [creativeId, setCreativeId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedVariants, setGeneratedVariants] = useState<GeneratedVariant[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityLog[]>([{ time: "Just now", text: "Studio session started", status: "done" }]);
  const [estimatedCost, setEstimatedCost] = useState(0);
  
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [smartScheduleModalOpen, setSmartScheduleModalOpen] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo | null>(null);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);
  
  const [variantRefineOpen, setVariantRefineOpen] = useState<Record<string, boolean>>({});
  const [variantRefineText, setVariantRefineText] = useState<Record<string, string>>({});
  const [regeneratingVariant, setRegeneratingVariant] = useState<string | null>(null);
  
  const [hashtagDialogOpen, setHashtagDialogOpen] = useState(false);
  const [hashtagSetName, setHashtagSetName] = useState("");
  const [hashtagsToSave, setHashtagsToSave] = useState<string[]>([]);
  const [savingHashtags, setSavingHashtags] = useState(false);

  const [subjectAssetId, setSubjectAssetId] = useState<string | null>(null);
  const [styleAssetIds, setStyleAssetIds] = useState<string[]>([]);
  const [contextAssetIds, setContextAssetIds] = useState<string[]>([]);
  const [packetPreviewOpen, setPacketPreviewOpen] = useState(false);

  const [recommendedSubjects, setRecommendedSubjects] = useState<Asset[]>([]);
  const [recommendedStyles, setRecommendedStyles] = useState<Asset[]>([]);
  const [compositingAssets, setCompositingAssets] = useState<Asset[]>([]);

  const { data: brandReadiness } = useBrandReadiness(selectedBrand || null);

  const generateDisabledReason = (() => {
    if (!selectedBrand) return "Select a brand";
    if (brandReadiness && !brandReadiness.ready) {
      const missingLabels = brandReadiness.missing
        .map(key => brandReadiness.checks[key]?.label)
        .filter(Boolean)
        .join(", ");
      return `Brand setup incomplete: ${missingLabels}`;
    }
    if (!selectedTemplate) return "Select a template";
    if (selectedAssets.length === 0) return "Select at least one asset";
    return null;
  })();

  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus | null>(null);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/settings/daily-budget-status`)
      .then(r => r.json())
      .then(setBudgetStatus)
      .catch((err) => console.error("Failed to load budget status:", err));
  }, [generatedVariants.length]);

  useEffect(() => {
    if (!selectedBrand) return;
    const fetchRecommended = async () => {
      try {
        const [subRes, styRes, compRes] = await Promise.all([
          apiFetch(`${API_BASE}/api/assets/recommended?brandId=${selectedBrand}&role=subject_reference${selectedTemplate ? `&templateId=${selectedTemplate}` : ''}`),
          apiFetch(`${API_BASE}/api/assets/recommended?brandId=${selectedBrand}&role=style_reference${selectedTemplate ? `&templateId=${selectedTemplate}` : ''}`),
          apiFetch(`${API_BASE}/api/assets/recommended?brandId=${selectedBrand}&role=compositing`),
        ]);
        if (subRes.ok) setRecommendedSubjects(await subRes.json());
        if (styRes.ok) setRecommendedStyles(await styRes.json());
        if (compRes.ok) setCompositingAssets(await compRes.json());
      } catch {
        toast({ variant: "destructive", title: "Could not load recommendations" });
      }
    };
    fetchRecommended();
  }, [selectedBrand, selectedTemplate]);

  useEffect(() => {
    const allIds: string[] = [];
    if (subjectAssetId) allIds.push(subjectAssetId);
    allIds.push(...styleAssetIds);
    allIds.push(...contextAssetIds);
    setSelectedAssets(allIds);
  }, [subjectAssetId, styleAssetIds, contextAssetIds]);

  const toggleStyleAsset = (id: string) => {
    setStyleAssetIds(prev => {
      if (prev.includes(id)) return prev.filter(a => a !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  };

  const toggleContextAsset = (id: string) => {
    setContextAssetIds(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);
  };

  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [audioDialogOpen, setAudioDialogOpen] = useState(false);
  const [audioDialogVariant, setAudioDialogVariant] = useState<GeneratedVariant | null>(null);
  const [audioSource, setAudioSource] = useState<"music" | "sfx" | "mute">("music");
  const [audioPrompt, setAudioPrompt] = useState("");
  const [audioMergeMode, setAudioMergeMode] = useState<"replace" | "mix">("replace");
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);

  const [rewriteToolbar, setRewriteToolbar] = useState<RewriteToolbarState | null>(null);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>({});

  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceStatus, setReferenceStatus] = useState<"idle" | "capturing" | "analyzing" | "done" | "error">("idle");
  const [referenceAnalysis, setReferenceAnalysis] = useState<Record<string, string> | null>(null);
  const [referenceScreenshots, setReferenceScreenshots] = useState<Array<{ url: string; viewport: string }>>([]);
  const [referenceError, setReferenceError] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const remixLoadedRef = useRef(false);
  const planLoadedRef = useRef(false);
  const loadingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  
  const createCreativeMutation = useCreateCreative();

  useEffect(() => {
    if (remixId && !remixLoadedRef.current) {
      remixLoadedRef.current = true;
      loadRemixCreative(remixId);
    }
  }, [remixId]);

  useEffect(() => {
    if (fromPlanCreativeId && !planLoadedRef.current) {
      planLoadedRef.current = true;
      loadPlanCreative(fromPlanCreativeId);
    }
  }, [fromPlanCreativeId]);

  const loadPlanCreative = async (id: string) => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${id}`);
      if (!resp.ok) return;
      const campaign = await resp.json();

      setCreativeId(campaign.id);
      setCreativeName(campaign.name || "");
      setSelectedBrand(campaign.brandId);
      if (campaign.templateId) setSelectedTemplate(campaign.templateId);
      setBriefText(campaign.briefText || "");

      const assets = (campaign.selectedAssets || []) as Array<{ assetId: string }>;
      setSelectedAssets(assets.map((a: { assetId: string }) => a.assetId));

      if (fromPlanPlatform) {
        const mapped = PLAN_PLATFORM_MAP[fromPlanPlatform.toLowerCase()];
        if (mapped && mapped.length > 0) {
          setSelectedPlatforms(mapped);
        }
      }

      try {
        const variantsResp = await apiFetch(`${API_BASE}/api/creatives/${id}/variants`);
        if (variantsResp.ok) {
          const variantsData = await variantsResp.json() as Array<Record<string, unknown>>;
          if (variantsData.length > 0) {
            setGeneratedVariants(variantsData.map(v => ({
              id: v.id as string | undefined,
              platform: v.platform as string,
              aspectRatio: v.aspectRatio as string,
              rawImageUrl: v.rawImageUrl as string | null,
              compositedImageUrl: v.compositedImageUrl as string | null,
              caption: v.caption as string,
              headlineText: v.headlineText as string | null,
              videoUrl: v.videoUrl as string | null ?? null,
              audioSource: v.audioSource as string | null ?? null,
              audioUrl: v.audioUrl as string | null ?? null,
              mergedVideoUrl: v.mergedVideoUrl as string | null ?? null,
            })));
          }
        }
      } catch {
        toast({ variant: "destructive", title: "Could not load creative variants" });
      }

      const platformNote = fromPlanPlatform ? ` (Primary platform: ${fromPlanPlatform})` : "";
      addLog(`Loaded from content plan: ${campaign.name}${platformNote}`, "done");
      toast({
        title: "Creative loaded from plan",
        description: fromPlanPlatform
          ? `Primary platform: ${fromPlanPlatform}. Configure and generate content.`
          : "Configure and generate content.",
      });
    } catch {
      toast({ variant: "destructive", title: "Failed to load creative from plan" });
    }
  };

  const loadRemixCreative = async (sourceId: string) => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${sourceId}`);
      if (!resp.ok) return;
      const source = await resp.json();

      setCreativeName(`${source.name} (Duplicate & Edit)`);
      setSelectedBrand(source.brandId);
      setBriefText(source.briefText || "");

      const assets = (source.selectedAssets || []) as Array<{ assetId: string }>;
      setSelectedAssets(assets.map((a: { assetId: string }) => a.assetId));

      addLog(`Duplicated from: ${source.name}`, "done");
      toast({ title: "Creative duplicated for editing", description: "Select a new template and generate." });
    } catch {
      toast({ variant: "destructive", title: "Failed to load source creative" });
    }
  };

  useEffect(() => {
    if (!selectedTemplate || !selectedAssets.length || duplicateDismissed) return;

    const primaryAssetId = selectedAssets[0];
    if (!primaryAssetId) return;

    const checkDuplicate = async () => {
      try {
        const resp = await apiFetch(`${API_BASE}/api/creatives/check-duplicate?templateId=${selectedTemplate}&primaryAssetId=${primaryAssetId}`);
        if (resp.ok) {
          const data = await resp.json();
          setDuplicateInfo(data);
        }
      } catch {
        toast({ variant: "destructive", title: "Duplicate check failed" });
      }
    };

    checkDuplicate();
  }, [selectedTemplate, selectedAssets, duplicateDismissed]);


  const addLog = useCallback((text: string, status: ActivityLog["status"] = "pending") => {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setActivityLog(prev => [{ time, text, status }, ...prev]);
  }, []);

  const updateLastLog = useCallback((status: ActivityLog["status"], text?: string) => {
    setActivityLog(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[0] = { ...updated[0], status, ...(text ? { text } : {}) };
      return updated;
    });
  }, []);

  const ensureCreativeId = useCallback(async (): Promise<string | null> => {
    if (creativeId) return creativeId;
    if (!selectedBrand) return null;

    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: creativeName || "Untitled Creative",
          brandId: selectedBrand,
          templateId: selectedTemplate || null,
          briefText,
          selectedAssets: selectedAssets.map((id, i) => ({ assetId: id, role: i === 0 ? "primary" : "supporting" })),
          sourceCreativeId: remixId || null,
          createdBy: "current_user",
        }),
      });
      if (!resp.ok) return null;
      const campaign = await resp.json();
      setCreativeId(campaign.id);
      return campaign.id;
    } catch {
      return null;
    }
  }, [creativeId, selectedBrand, creativeName, selectedTemplate, briefText, selectedAssets, remixId]);

  const processSSEStream = useCallback(async (
    response: Response,
    onCaptured: (screenshots: Array<{ url: string; viewport: string }>) => void,
    onComplete: (data: { referenceAnalysis: Record<string, string>; referenceScreenshots: Array<{ url: string; viewport: string }> }) => void,
    onError: (message: string) => void,
  ) => {
    if (!response.body) {
      onError("No response stream");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ") && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6));
            if (currentEvent === "captured") {
              onCaptured(data.referenceScreenshots || []);
            } else if (currentEvent === "complete") {
              onComplete({
                referenceAnalysis: data.referenceAnalysis,
                referenceScreenshots: data.referenceScreenshots || [],
              });
            } else if (currentEvent === "error") {
              onError(data.message || "Analysis failed");
            }
          } catch {
            onError("Received malformed data from server");
          }
          currentEvent = "";
        }
      }
    }
  }, []);

  const handleAnalyzeUrl = useCallback(async () => {
    if (!referenceUrl.trim()) return;

    try {
      new URL(referenceUrl);
    } catch {
      setReferenceError("Please enter a valid URL");
      setReferenceStatus("error");
      return;
    }

    if (!selectedBrand) {
      toast({ variant: "destructive", title: "Select a brand first" });
      return;
    }

    setReferenceStatus("capturing");
    setReferenceError("");

    const cId = await ensureCreativeId();
    if (!cId) {
      setReferenceStatus("error");
      setReferenceError("Failed to create creative");
      return;
    }

    try {
      addLog("Capturing reference page...", "pending");

      const resp = await apiFetch(`${API_BASE}/api/creatives/${cId}/analyze-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: referenceUrl }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Analysis failed" }));
        throw new Error(err.error || "Analysis failed");
      }

      await processSSEStream(
        resp,
        (screenshots) => {
          setReferenceScreenshots(screenshots);
          setReferenceStatus("analyzing");
          addLog("Analyzing reference design...", "pending");
        },
        (data) => {
          setReferenceAnalysis(data.referenceAnalysis);
          setReferenceScreenshots(data.referenceScreenshots);
          setReferenceStatus("done");
          addLog("Reference analyzed ✓", "done");
        },
        (message) => {
          throw new Error(message);
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      setReferenceStatus("error");
      setReferenceError(msg);
      addLog(`Reference analysis failed: ${msg}`, "error");
    }
  }, [referenceUrl, selectedBrand, ensureCreativeId, addLog, toast, processSSEStream]);

  const handleUploadScreenshot = useCallback(async (file: File) => {
    if (!selectedBrand) {
      toast({ variant: "destructive", title: "Select a brand first" });
      return;
    }

    setReferenceStatus("capturing");
    setReferenceError("");

    const cId = await ensureCreativeId();
    if (!cId) {
      setReferenceStatus("error");
      setReferenceError("Failed to create creative");
      return;
    }

    try {
      addLog("Processing uploaded screenshot...", "pending");

      const formData = new FormData();
      formData.append("screenshot", file);

      const resp = await apiFetch(`${API_BASE}/api/creatives/${cId}/analyze-upload`, {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Upload analysis failed" }));
        throw new Error(err.error || "Upload analysis failed");
      }

      await processSSEStream(
        resp,
        (screenshots) => {
          setReferenceScreenshots(screenshots);
          setReferenceStatus("analyzing");
          addLog("Analyzing reference design...", "pending");
        },
        (data) => {
          setReferenceAnalysis(data.referenceAnalysis);
          setReferenceScreenshots(data.referenceScreenshots);
          setReferenceStatus("done");
          setReferenceUrl(file.name);
          addLog("Uploaded reference analyzed ✓", "done");
        },
        (message) => {
          throw new Error(message);
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload analysis failed";
      setReferenceStatus("error");
      setReferenceError(msg);
      addLog(`Reference analysis failed: ${msg}`, "error");
    }
  }, [selectedBrand, ensureCreativeId, addLog, toast, processSSEStream]);

  const handleClearReference = useCallback(async () => {
    setReferenceUrl("");
    setReferenceStatus("idle");
    setReferenceAnalysis(null);
    setReferenceScreenshots([]);
    setReferenceError("");

    if (creativeId) {
      try {
        await apiFetch(`${API_BASE}/api/creatives/${creativeId}/reference`, {
          method: "DELETE",
        });
      } catch {
        toast({ variant: "destructive", title: "Failed to clear reference" });
      }
    }
  }, [creativeId, toast]);

  const handleSaveDraft = useCallback(async () => {
    if (!selectedBrand) {
      toast({ variant: "destructive", title: "Brand required" });
      return;
    }
    
    createCreativeMutation.mutate({
      data: {
        name: creativeName || "Untitled Creative",
        brandId: selectedBrand,
        templateId: selectedTemplate || null,
        briefText,
        selectedAssets: selectedAssets.map((id, i) => ({ assetId: id, role: i === 0 ? "primary" : "supporting" })),
        sourceCreativeId: remixId || null,
        createdBy: "current_user",
      } as CreateCreativeInput
    }, {
      onSuccess: (data) => {
        setCreativeId(data.id);
        toast({ title: "Draft Saved", description: "Creative saved successfully." });
        addLog("Creative draft saved", "done");
      }
    });
  }, [selectedBrand, creativeName, selectedTemplate, briefText, selectedAssets, remixId, createCreativeMutation, toast, addLog]);

  const handleGenerate = useCallback(async () => {
    if (!selectedBrand || !selectedTemplate) {
      toast({ variant: "destructive", title: "Select a brand and template first" });
      return;
    }

    setIsGenerating(true);
    setGeneratedVariants([]);
    loadingTimersRef.current.forEach(t => clearTimeout(t));
    loadingTimersRef.current.clear();
    setLoadingPhase({});
    const platforms = selectedPlatforms.length > 0 ? selectedPlatforms : ALL_PLATFORM_KEYS;
    const initialPhase: Record<string, { caption: boolean; image: boolean }> = {};
    platforms.forEach(p => { initialPhase[p] = { caption: false, image: false }; });
    setLoadingPhase(initialPhase);
    setGeneratedVariants(platforms.map(p => ({
      platform: p,
      aspectRatio: PLATFORM_LABELS[p].ratio,
      rawImageUrl: null,
      compositedImageUrl: null,
      caption: "",
      headlineText: null,
    })));
    addLog("Creating creative...", "pending");

    try {
      let cId = creativeId;

      if (!cId) {
        const resp = await apiFetch(`${API_BASE}/api/creatives`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: creativeName || "Untitled Creative",
            brandId: selectedBrand,
            templateId: selectedTemplate,
            briefText,
            selectedAssets: selectedAssets.map((id, i) => ({ assetId: id, role: i === 0 ? "primary" : "supporting" })),
            sourceCreativeId: remixId || null,
            createdBy: "current_user",
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: "Failed to create creative" }));
          throw new Error(err.error || "Failed to create creative");
        }
        const campaign = await resp.json();
        cId = campaign.id;
        setCreativeId(cId!);
      } else {
        const resp = await apiFetch(`${API_BASE}/api/creatives/${cId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateId: selectedTemplate,
            briefText,
            selectedAssets: selectedAssets.map((id, i) => ({ assetId: id, role: i === 0 ? "primary" : "supporting" })),
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: "Failed to update creative" }));
          throw new Error(err.error || "Failed to update creative");
        }
      }

      updateLastLog("done");
      addLog("Starting AI generation pipeline...", "pending");

      const controller = new AbortController();
      abortRef.current = controller;

      const response = await apiFetch(`${API_BASE}/api/creatives/${cId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("Failed to start generation");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(currentEvent, data);
            } catch {
              addLog("Received malformed data from server", "error");
            }
            currentEvent = "";
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        addLog("Generation cancelled", "error");
      } else {
        const msg = err instanceof Error ? err.message : "Unknown error";
        addLog(`Generation failed: ${msg}`, "error");
        toast({ variant: "destructive", title: "Generation Failed", description: msg });
      }
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  }, [selectedBrand, selectedTemplate, creativeId, creativeName, briefText, selectedAssets, selectedPlatforms, remixId, toast, addLog, updateLastLog]);

  const handleSSEEvent = useCallback((event: string, data: Record<string, unknown>) => {
    switch (event) {
      case "progress": {
        const message = data.message as string;
        const isDone = data.done as boolean;
        if (isDone) {
          addLog(message, "done");
        } else {
          addLog(message, "pending");
        }
        break;
      }
      case "image_progress": {
        const platform = data.platform as string;
        const status = data.status as string;
        const label = PLATFORM_LABELS[platform]?.name || platform;
        if (status === "started") {
          addLog(`Generating ${label} image...`, "pending");
        } else if (status === "completed") {
          updateLastLog("done");
        } else if (status === "failed") {
          const error = data.error as string | undefined;
          updateLastLog("error", `${label} image failed${error ? `: ${error}` : ""}`);
        }
        break;
      }
      case "caption_ready": {
        const platform = data.platform as string;
        setLoadingPhase(prev => ({
          ...prev,
          [platform]: { ...prev[platform], caption: true },
        }));
        setGeneratedVariants(prev => prev.map(v =>
          v.platform === platform ? {
            ...v,
            caption: data.caption as string,
            headlineText: data.headline as string | null,
            aspectRatio: data.aspectRatio as string || v.aspectRatio,
          } : v
        ));
        addLog(`${PLATFORM_LABELS[platform]?.name || platform} caption ready`, "done");
        break;
      }
      case "image_ready": {
        const platform = data.platform as string;
        setGeneratedVariants(prev => prev.map(v =>
          v.platform === platform ? {
            ...v,
            rawImageUrl: data.rawImageUrl as string | null,
            compositedImageUrl: data.compositedImageUrl as string | null,
            aspectRatio: data.aspectRatio as string || v.aspectRatio,
          } : v
        ));
        setLoadingPhase(prev => ({
          ...prev,
          [platform]: { ...prev[platform], image: true },
        }));
        break;
      }
      case "variant_ready": {
        const platform = data.platform as string;
        setLoadingPhase(prev => ({
          ...prev,
          [platform]: { caption: true, image: true },
        }));
        setGeneratedVariants(prev => prev.map(v =>
          v.platform === platform ? {
            ...v,
            caption: data.caption as string,
            headlineText: data.headline as string | null,
            rawImageUrl: data.rawImageUrl as string | null,
            compositedImageUrl: data.compositedImageUrl as string | null,
            aspectRatio: data.aspectRatio as string || v.aspectRatio,
          } : v
        ));
        break;
      }
      case "complete": {
        const variants = data.variants as Array<Record<string, unknown>> | undefined;
        const cost = data.estimatedCost as number | undefined;
        if (variants) {
          setGeneratedVariants(variants.map(v => ({
            id: v.id as string | undefined,
            platform: v.platform as string,
            aspectRatio: v.aspectRatio as string,
            rawImageUrl: v.rawImageUrl as string | null,
            compositedImageUrl: v.compositedImageUrl as string | null,
            caption: v.caption as string,
            headlineText: v.headlineText as string | null,
            videoUrl: v.videoUrl as string | null ?? null,
            audioSource: v.audioSource as string | null ?? null,
            audioUrl: v.audioUrl as string | null ?? null,
            mergedVideoUrl: v.mergedVideoUrl as string | null ?? null,
          })));
        }
        if (cost) setEstimatedCost(cost);
        setLoadingPhase({});
        addLog("Generation complete!", "done");
        break;
      }
      case "error": {
        addLog(data.message as string, "error");
        break;
      }
    }
  }, [addLog, updateLastLog]);

  const handleCaptionChange = useCallback(async (variantId: string | undefined, platform: string, newCaption: string) => {
    setGeneratedVariants(prev => prev.map(v => 
      v.platform === platform ? { ...v, caption: newCaption } : v
    ));

    if (variantId && creativeId) {
      try {
        await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants/${variantId}/caption`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caption: newCaption }),
        });
      } catch {
        toast({ variant: "destructive", title: "Failed to save caption" });
      }
    }
  }, [creativeId, toast]);

  const handleRewrite = useCallback(async (text: string, instruction: string): Promise<string> => {
    const resp = await apiFetch(`${API_BASE}/api/rewrite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, instruction }),
    });
    if (!resp.ok) throw new Error("Rewrite failed");
    const data = await resp.json();
    return data.rewritten;
  }, []);

  const handleTextSelect = useCallback((platform: string, textarea: HTMLTextAreaElement) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const rawSelected = textarea.value.substring(start, end);

    if (!rawSelected.trim() || rawSelected.trim().length < 3) {
      setRewriteToolbar(null);
      return;
    }

    const rect = textarea.getBoundingClientRect();
    const parentRect = textarea.closest(".relative")?.getBoundingClientRect() || rect;
    setRewriteToolbar({
      platform,
      selectedText: rawSelected.trim(),
      selectionStart: start,
      selectionEnd: end,
      position: {
        top: rect.top - parentRect.top - 40,
        left: (rect.width) / 2,
      },
    });
  }, []);

  const handleHeadlineSave = useCallback(async (variantId: string | undefined, platform: string, newHeadline: string) => {
    if (!variantId || !creativeId) {
      throw new Error("Cannot save yet");
    }

    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants/${variantId}/headline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: newHeadline }),
      });
      if (!resp.ok) throw new Error("Failed to save headline");
      const updated = await resp.json();
      setGeneratedVariants(prev => prev.map(v =>
        v.platform === platform ? {
          ...v,
          headlineText: newHeadline,
          compositedImageUrl: updated.compositedImageUrl,
          imageVersion: (v.imageVersion || 0) + 1,
        } : v
      ));
      toast({ title: "Headline updated", description: "Image re-composited with new text." });
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update headline" });
      throw err;
    }
  }, [creativeId, toast]);

  const handleDownloadAll = useCallback(() => {
    if (!creativeId) return;
    window.open(`${API_BASE}/api/creatives/${creativeId}/download`, "_blank");
  }, [creativeId]);

  const handleDownloadVariant = useCallback((variantId: string | undefined) => {
    if (!creativeId || !variantId) return;
    window.open(`${API_BASE}/api/creatives/${creativeId}/variants/${variantId}/download`, "_blank");
  }, [creativeId]);

  const handleSubmitForReview = useCallback(async () => {
    if (!creativeId) return;
    try {
      await apiFetch(`${API_BASE}/api/creatives/${creativeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending_review" }),
      });
      toast({ title: "Submitted!", description: "Creative sent to Review Queue." });
      addLog("Submitted for review", "done");
    } catch {
      toast({ variant: "destructive", title: "Failed to submit" });
    }
  }, [creativeId, toast, addLog]);

  const handleGenerateVideo = useCallback(async () => {
    if (!creativeId) {
      toast({ variant: "destructive", title: "Generate images first" });
      return;
    }

    setIsGeneratingVideo(true);
    addLog("Starting video generation...", "pending");

    try {
      const response = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/generate-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientations: ["landscape", "portrait"] }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Failed to start video generation");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "video_progress") {
                const orientation = data.orientation as string;
                const status = data.status as string;
                if (status === "started") {
                  addLog(`Generating ${orientation} video...`, "pending");
                } else if (status === "completed") {
                  updateLastLog("done");
                  if (data.videoUrl) {
                    const matchingRatio = orientation === "landscape" ? "16:9" : "9:16";
                    setGeneratedVariants(prev => prev.map(v =>
                      v.aspectRatio === matchingRatio ? { ...v, videoUrl: data.videoUrl as string } : v
                    ));
                  }
                } else if (status === "failed") {
                  updateLastLog("error");
                }
              } else if (currentEvent === "complete") {
                addLog("Video generation complete!", "done");
              } else if (currentEvent === "error") {
                addLog(data.message as string, "error");
              } else if (currentEvent === "progress") {
                addLog(data.message as string, data.done ? "done" : "pending");
              }
            } catch {
              addLog("Received malformed data from server", "error");
            }
            currentEvent = "";
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addLog(`Video generation failed: ${msg}`, "error");
      toast({ variant: "destructive", title: "Video Generation Failed", description: msg });
    } finally {
      setIsGeneratingVideo(false);
    }
  }, [creativeId, addLog, updateLastLog, toast]);

  const handleSetAudio = useCallback(async () => {
    if (!creativeId || !audioDialogVariant?.id) return;

    setIsGeneratingAudio(true);
    addLog(`Generating ${audioSource} audio...`, "pending");

    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants/${audioDialogVariant.id}/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: audioSource,
          prompt: audioPrompt,
          mode: audioMergeMode,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Audio generation failed" }));
        throw new Error(err.error || "Audio generation failed");
      }

      const updated = await resp.json();
      setGeneratedVariants(prev => prev.map(v =>
        v.id === audioDialogVariant.id
          ? { ...v, audioSource: updated.audioSource, audioUrl: updated.audioUrl, mergedVideoUrl: updated.mergedVideoUrl }
          : v
      ));

      updateLastLog("done");
      toast({ title: "Audio applied!", description: `${audioSource} audio added to variant.` });
      setAudioDialogOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addLog(`Audio failed: ${msg}`, "error");
      toast({ variant: "destructive", title: "Audio Failed", description: msg });
    } finally {
      setIsGeneratingAudio(false);
    }
  }, [creativeId, audioDialogVariant, audioSource, audioPrompt, audioMergeMode, addLog, updateLastLog, toast]);

  const handleUploadAudio = useCallback(async (variantId: string, file: File) => {
    if (!creativeId) return;

    addLog("Uploading custom audio...", "pending");

    try {
      const formData = new FormData();
      formData.append("audio", file);
      formData.append("mode", audioMergeMode);

      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants/${variantId}/audio-upload`, {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }

      const updated = await resp.json();
      setGeneratedVariants(prev => prev.map(v =>
        v.id === variantId
          ? { ...v, audioSource: updated.audioSource, audioUrl: updated.audioUrl, mergedVideoUrl: updated.mergedVideoUrl }
          : v
      ));

      updateLastLog("done");
      toast({ title: "Custom audio applied!" });
      setAudioDialogOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addLog(`Audio upload failed: ${msg}`, "error");
      toast({ variant: "destructive", title: "Upload Failed", description: msg });
    }
  }, [creativeId, audioMergeMode, addLog, updateLastLog, toast]);

  const handleVariantRegenerate = useCallback(async (variantId: string, platform: string) => {
    if (!creativeId || !variantId) return;
    const instruction = variantRefineText[platform] || "";
    
    setRegeneratingVariant(platform);
    addLog(`Regenerating ${PLATFORM_LABELS[platform]?.name || platform}...`, "pending");

    try {
      const resp = await apiFetch(`${API_BASE}/api/creatives/${creativeId}/variants/${variantId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Regeneration failed" }));
        throw new Error(err.error || "Regeneration failed");
      }

      const updated = await resp.json();
      setGeneratedVariants(prev => prev.map(v =>
        v.platform === platform
          ? { ...v, rawImageUrl: updated.rawImageUrl, compositedImageUrl: updated.compositedImageUrl, id: updated.id, imageVersion: (v.imageVersion || 0) + 1 }
          : v
      ));

      setVariantRefineText(prev => ({ ...prev, [platform]: "" }));
      setVariantRefineOpen(prev => ({ ...prev, [platform]: false }));
      addLog(`${PLATFORM_LABELS[platform]?.name || platform} regenerated`, "done");
      toast({ title: "Post version regenerated" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addLog(`Regeneration failed: ${msg}`, "error");
      toast({ variant: "destructive", title: "Regeneration failed", description: msg });
    } finally {
      setRegeneratingVariant(null);
    }
  }, [creativeId, variantRefineText, addLog, toast]);

  const extractHashtags = useCallback((caption: string): string[] => {
    const matches = caption.match(/#[a-zA-Z0-9_]+/g);
    return matches ? [...new Set(matches)] : [];
  }, []);

  const handleSaveHashtagSet = useCallback(async () => {
    if (!selectedBrand || !hashtagSetName.trim() || hashtagsToSave.length === 0) return;
    
    setSavingHashtags(true);
    try {
      const resp = await apiFetch(`${API_BASE}/api/hashtag-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId: selectedBrand,
          name: hashtagSetName.trim(),
          hashtags: hashtagsToSave.map(h => h.startsWith("#") ? h.slice(1) : h),
          category: "saved",
        }),
      });

      if (!resp.ok) throw new Error("Failed to save");

      toast({ title: "Hashtag set saved", description: `"${hashtagSetName}" saved with ${hashtagsToSave.length} hashtags.` });
      setHashtagDialogOpen(false);
      setHashtagSetName("");
      setHashtagsToSave([]);
    } catch {
      toast({ variant: "destructive", title: "Failed to save hashtag set" });
    } finally {
      setSavingHashtags(false);
    }
  }, [selectedBrand, hashtagSetName, hashtagsToSave, toast]);

  if (brands === undefined) {
    return <CreativeStudioSkeleton />;
  }

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">

      <CreativeConfigPanel
        remixId={remixId}
        creativeName={creativeName}
        onCreativeNameChange={setCreativeName}
        brands={brands}
        selectedBrand={selectedBrand}
        onBrandChange={(v) => { setSelectedBrand(v); setSelectedTemplate(""); }}
        templates={templates}
        selectedTemplate={selectedTemplate}
        onTemplateChange={(v) => { setSelectedTemplate(v); setDuplicateDismissed(false); }}
        subjectAssetId={subjectAssetId}
        onSubjectAssetChange={setSubjectAssetId}
        recommendedSubjects={recommendedSubjects}
        approvedVisualAssets={approvedAssets?.data?.filter(a => a.type === "visual") || []}
        styleAssetIds={styleAssetIds}
        onToggleStyleAsset={toggleStyleAsset}
        recommendedStyles={recommendedStyles}
        contextAssetIds={contextAssetIds}
        onToggleContextAsset={toggleContextAsset}
        briefs={briefs}
        compositingAssets={compositingAssets}
        packetPreviewOpen={packetPreviewOpen}
        onPacketPreviewToggle={() => setPacketPreviewOpen(!packetPreviewOpen)}
        approvedAssets={approvedAssets}
        referenceUrl={referenceUrl}
        onReferenceUrlChange={setReferenceUrl}
        referenceStatus={referenceStatus}
        referenceError={referenceError}
        referenceAnalysis={referenceAnalysis}
        referenceScreenshots={referenceScreenshots}
        onAnalyzeUrl={handleAnalyzeUrl}
        onUploadScreenshot={handleUploadScreenshot}
        onClearReference={handleClearReference}
        briefText={briefText}
        onBriefTextChange={setBriefText}
        onBriefSelect={(val) => {
          const brief = briefs?.data?.find(b => b.id === val);
          if (brief) setBriefText(brief.content || "");
        }}
        selectedPlatforms={selectedPlatforms}
        onSelectedPlatformsChange={setSelectedPlatforms}
        onGenerate={handleGenerate}
        onGenerateVideo={handleGenerateVideo}
        isGenerating={isGenerating}
        isGeneratingVideo={isGeneratingVideo}
        generateDisabledReason={generateDisabledReason}
        budgetStatus={budgetStatus}
        estimatedCost={estimatedCost}
        creativeId={creativeId}
        hasVariants={generatedVariants.length > 0}
      />

      <VariantGrid
        refineText={refineText}
        onRefineTextChange={setRefineText}
        onRefineSubmit={() => {}}
        isGenerating={isGenerating}
        generatedVariants={generatedVariants}
        selectedBrand={selectedBrand}
        duplicateInfo={duplicateInfo}
        duplicateDismissed={duplicateDismissed}
        onDismissDuplicate={() => setDuplicateDismissed(true)}
        loadingPhase={loadingPhase}
        selectedPlatforms={selectedPlatforms}
        regeneratingVariant={regeneratingVariant}
        variantRefineOpen={variantRefineOpen}
        variantRefineText={variantRefineText}
        rewriteToolbar={rewriteToolbar}
        isGeneratingAudio={isGeneratingAudio}
        onDownloadVariant={handleDownloadVariant}
        onCaptionChange={handleCaptionChange}
        onTextSelect={handleTextSelect}
        onRewrite={handleRewrite}
        onHeadlineSave={handleHeadlineSave}
        onVariantRegenerate={handleVariantRegenerate}
        extractHashtags={extractHashtags}
        onRewriteToolbarClose={() => setRewriteToolbar(null)}
        onSetVariantRefineOpen={setVariantRefineOpen}
        onSetVariantRefineText={setVariantRefineText}
        onOpenAudioDialog={(v) => {
          setAudioDialogVariant(v);
          setAudioSource("music");
          setAudioPrompt("");
          setAudioDialogOpen(true);
        }}
        onOpenHashtagDialog={(hashtags) => {
          setHashtagsToSave(hashtags);
          setHashtagDialogOpen(true);
        }}
      />

      <ActivityPanel
        activityLog={activityLog}
        estimatedCost={estimatedCost}
        onSaveDraft={handleSaveDraft}
        isSaving={createCreativeMutation.isPending}
        onDownloadAll={handleDownloadAll}
        onSchedule={() => setScheduleModalOpen(true)}
        onSmartSchedule={() => setSmartScheduleModalOpen(true)}
        onSubmitForReview={handleSubmitForReview}
        hasVariants={generatedVariants.length > 0}
        creativeId={creativeId}
        isGenerating={isGenerating}
      />

      {creativeId && (
        <>
          <ScheduleModal
            open={scheduleModalOpen}
            onOpenChange={setScheduleModalOpen}
            creativeId={creativeId}
            creativeName={creativeName || "Untitled Creative"}
            onScheduled={() => {
              addLog("Creative scheduled", "done");
              toast({ title: "Scheduled!", description: "Creative added to calendar." });
            }}
          />
          <SmartScheduleModal
            open={smartScheduleModalOpen}
            onClose={() => setSmartScheduleModalOpen(false)}
            creativeIds={creativeId ? [creativeId] : []}
            onScheduled={() => {
              addLog("Smart scheduled", "done");
              toast({ title: "Smart Scheduled!", description: "AI-optimized schedule added to calendar." });
            }}
          />
        </>
      )}

      <HashtagSetDialog
        open={hashtagDialogOpen}
        onOpenChange={setHashtagDialogOpen}
        hashtagSetName={hashtagSetName}
        onNameChange={setHashtagSetName}
        hashtagsToSave={hashtagsToSave}
        onRemoveHashtag={(index) => setHashtagsToSave(prev => prev.filter((_, idx) => idx !== index))}
        onSave={handleSaveHashtagSet}
        isSaving={savingHashtags}
      />

      <AudioSettingsDialog
        open={audioDialogOpen}
        onOpenChange={setAudioDialogOpen}
        audioSource={audioSource}
        onSourceChange={(v) => setAudioSource(v as "music" | "sfx" | "mute")}
        audioPrompt={audioPrompt}
        onPromptChange={setAudioPrompt}
        audioMergeMode={audioMergeMode}
        onMergeModeChange={(v) => setAudioMergeMode(v as "replace" | "mix")}
        onApply={handleSetAudio}
        onUploadAudio={(file) => {
          if (audioDialogVariant?.id) {
            handleUploadAudio(audioDialogVariant.id, file);
          }
        }}
        isGenerating={isGeneratingAudio}
      />
    </div>
  );
}
