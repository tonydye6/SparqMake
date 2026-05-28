import { apiFetch } from "@/lib/utils";
import React, { useCallback, useRef, useState } from "react";
import { Upload, CheckCircle2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { WizardStepShell } from "@/components/setup/WizardStepShell";
import { useToast } from "@/hooks/use-toast";

interface StepUploadLogoProps {
  brandId: string | null;
  readiness: { checks?: { logo?: { passed: boolean } } } | null;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export default function StepUploadLogo({
  brandId,
  readiness,
  onNext,
  onBack,
  onSkip,
}: StepUploadLogoProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!brandId) {
        toast({ title: "No brand selected", variant: "destructive" });
        return;
      }

      if (!ACCEPTED_TYPES.split(",").includes(file.type)) {
        toast({ title: "Unsupported file type", description: "Use PNG, JPEG, WebP, or GIF.", variant: "destructive" });
        return;
      }
      if (file.size > MAX_LOGO_BYTES) {
        toast({ title: "File too large", description: "Logos must be under 5 MB.", variant: "destructive" });
        return;
      }

      // Show preview via FileReader
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);

      // Upload
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("logo", file);

        const res = await apiFetch(`/api/brands/${brandId}/logos`, {
          method: "POST",
          body: formData,
          credentials: "include",
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData?.message ?? `Upload failed (${res.status})`);
        }

        setUploaded(true);
        queryClient.invalidateQueries({ queryKey: ["brand-readiness", brandId] });
        toast({ title: "Logo uploaded!", description: "Your brand logo has been saved." });
      } catch (err) {
        const message = err instanceof Error ? err.message : "An unexpected error occurred.";
        toast({ title: "Upload failed", description: message, variant: "destructive" });
      } finally {
        setUploading(false);
      }
    },
    [brandId, queryClient, toast]
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset input so the same file can be re-selected
      e.target.value = "";
    },
    [handleFile]
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const canNext = readiness?.checks?.logo?.passed ?? false;

  return (
    <WizardStepShell
      title="Upload your brand logo"
      description="Your logo will be composited onto generated images"
      canNext={canNext}
      showBack
      showSkip
      onNext={onNext}
      onBack={onBack}
      onSkip={onSkip}
    >
      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={onInputChange}
        aria-label="Upload logo file"
      />

      {uploaded && preview ? (
        /* Post-upload state */
        <div className="flex flex-col items-center gap-4">
          <div className="relative inline-block">
            <img
              src={preview}
              alt="Uploaded logo preview"
              className="max-h-48 max-w-full rounded-lg border border-border object-contain shadow"
            />
            <span className="absolute -top-2 -right-2 bg-background rounded-full">
              <CheckCircle2 className="w-6 h-6 text-green-500" />
            </span>
          </div>

          <p className="text-sm font-medium text-foreground">Logo uploaded!</p>

          <button
            type="button"
            onClick={openFilePicker}
            disabled={uploading}
            className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded disabled:opacity-50"
          >
            Replace logo
          </button>
        </div>
      ) : (
        /* Dropzone / pre-upload state */
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload logo drop zone"
          onClick={openFilePicker}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePicker();
            }
          }}
          className="relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-muted/40 p-12 text-center cursor-pointer transition-colors hover:border-primary hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {/* Spinner overlay during upload */}
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/60 backdrop-blur-sm">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          <Upload className="w-10 h-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Drag your logo here or click to browse
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              PNG, JPEG, WebP, or GIF (max 5 MB)
            </p>
          </div>
        </div>
      )}
    </WizardStepShell>
  );
}
