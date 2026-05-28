# SparqMake — Frontend Code Review & Fix Specification

**Repository:** `tonydye6/SparqMake`
**Scope reviewed:** React app under `artifacts/sparqmake/src` — pages, components, state management, data fetching (focus on the recently-changed AssetLibrary, Calendar, and Settings areas).
**Branch/commit at review:** `master` @ `142b40b`
**Reviewer:** Claude (code-review)
**Date:** 2026-05-28

---

## How to use this document (for the Replit Agent)

This is a prioritized, ready-to-implement punch list. Each item below has:

- **Location** — `file:line` anchor (paths are repo-relative).
- **Problem** — what's wrong and why it matters.
- **Fix** — concrete before/after code. Apply it to the current file (line numbers may have shifted slightly; match on the code, not the line number).
- **Why** — one-line rationale.

Work the list **top to bottom** — it is ordered by severity/impact. Items 1–4 are the ones to fix before shipping. Items 13–16 are safe cleanups.

**Important:** The "Investigated — NOT a bug" section at the end lists things that look wrong but are actually correct. **Do not "fix" those** — you'll introduce regressions.

---

## Summary

The frontend is well-structured: clean separation between generated TanStack Query hooks (`@workspace/api-client-react`) and the `apiFetch` wrapper, consistent shadcn/Radix UI, sensible query-cache defaults (`refetchOnWindowFocus: false`, 5-min `staleTime`), and good loading/skeleton states. The cookie-session + Origin/Referer CSRF model is correctly matched on the client (no CSRF token needed — this is intentional, not a bug).

The issues that matter cluster in three areas:

1. **Untrusted-input handling on uploads** — unsanitized SVG logo upload; URL string-interpolated into an inline `<style>`.
2. **Date/timezone correctness** — the calendar "Edit Time" control corrupts scheduled times for non-UTC users.
3. **React effect/state anti-patterns** — a data fetch run as a render side-effect, a keyless list Fragment, an upload queue that drops files dropped mid-upload, and a first-run guard that misroutes users on a network error.

No SQL injection, secret leakage, or auth-bypass issues were found in the frontend.

---

## Findings index

| # | Severity | Area | File:Line | One-liner |
|---|----------|------|-----------|-----------|
| 1 | 🔴 High | Correctness | `pages/Calendar.tsx:763` | "Edit Time" feeds a UTC string into `datetime-local` → time shifts by user's offset |
| 2 | 🔴 High | Security | `components/setup/StepUploadLogo.tsx:16` | Accepts unsanitized SVG logo uploads (stored-XSS vector) |
| 3 | 🟠 Med-High | Correctness | `pages/Calendar.tsx:143` | Data fetch run inside `useMemo` (side-effect during render) |
| 4 | 🟠 Medium | Security | `pages/Settings.tsx:1171` | Font URL interpolated into inline `<style>` → CSS injection |
| 5 | 🟠 Medium | Correctness | `pages/AssetLibrary.tsx:106-181` | Files dropped during an active upload are silently discarded; index-based queue writes can corrupt state |
| 6 | 🟠 Medium | Correctness | `pages/AssetLibrary.tsx:514` | `isSubjectReference` OR-logic treats **every image** as a subject reference |
| 7 | 🟠 Medium | Correctness | `pages/Calendar.tsx:294-328` | Optimistic reschedule never re-syncs server-computed fields |
| 8 | 🟠 Medium | Correctness | `hooks/useFormDirty.ts:31` | `beforeunload` guard missing `returnValue` → unreliable in Firefox/Safari |
| 9 | 🟠 Medium | Correctness | `components/ScheduleProfileEditor.tsx:274` | Keyless `<>` Fragment as the `.map()` root → React key warning |
| 10 | 🟠 Medium | UX/Correctness | `App.tsx:68-98` | `FirstRunGuard` redirects to `/setup` on a fetch **error**, not just when empty |
| 11 | 🟠 Medium | Data integrity | `AssetLibrary.tsx:138,757` · `Settings.tsx:1061` | `uploadedBy: "current_user"` hardcoded placeholder written to DB |
| 12 | 🟠 Medium | Security/Consistency | `pages/Login.tsx:3-4` | Unvalidated `returnTo`; omits the `VITE_API_URL` prefix others use |
| 13 | 🟡 Low-Med | Maintainability | `pages/Settings.tsx:606-615` | Update payload spreads the entire brand entity (server-managed fields) |
| 14 | 🟡 Low-Med | Maintainability | `pages/Settings.tsx:566-582` | `reset()` re-maps every field by hand, duplicating `defaultValues` |
| 15 | 🟡 Low | Type safety | `pages/Settings.tsx:532,574` | `timezone` accessed via `as Record<string, unknown>` cast (missing on type) |
| 16 | 🟡 Low-Med | UX | `AssetLibrary.tsx:181` · `StepUploadLogo.tsx` | Dropzones do no client-side type/size validation |

---

## Detailed fixes

### 1. 🔴 Calendar "Edit Time" corrupts scheduled time for non-UTC users

**Location:** `artifacts/sparqmake/src/pages/Calendar.tsx:763`

**Problem:** When opening the Edit-Time popover, the entry's timestamp is converted to **UTC** and sliced into the `<input type="datetime-local">`. That input expects **local** wall-clock time (`YYYY-MM-DDTHH:mm`). For any non-UTC user the displayed value is shifted by their offset (e.g. a 3:00 PM ET post shows as 8:00 PM). On save, `handleEditTimeSave` parses the string with `new Date(editTimeValue)` — which correctly interprets it as **local** — so the wrong digits get committed: a silent corruption of scheduled post times.

**Fix:** Format the value in local time. The file already imports `date-fns`.

```tsx
// at top, ensure: import { format } from "date-fns";

// BEFORE (line ~763)
onClick={(e) => {
  e.stopPropagation();
  const dt = new Date(entry.scheduledAt);
  setEditTimeValue(dt.toISOString().slice(0, 16)); // ❌ UTC into a local-time input
  setEditTimeEntry(entry);
}}

// AFTER
onClick={(e) => {
  e.stopPropagation();
  const dt = new Date(entry.scheduledAt);
  setEditTimeValue(format(dt, "yyyy-MM-dd'T'HH:mm")); // ✅ local wall-clock
  setEditTimeEntry(entry);
}}
```

No change needed in `handleEditTimeSave` — `new Date(editTimeValue)` already parses a zoneless `datetime-local` string as local time, so once the display is local the round-trip is correct.

**Why:** `datetime-local` is a local-time control; feeding it UTC and reading it back as local double-shifts the timestamp.

---

### 2. 🔴 Unsanitized SVG logo upload (stored-XSS vector)

**Location:** `artifacts/sparqmake/src/components/setup/StepUploadLogo.tsx:16` (and helper text at line ~185)

**Problem:** `ACCEPTED_TYPES` includes `image/svg+xml`, and there's no size cap. The in-app preview via `<img src={dataURL}>` is itself safe (scripts in an SVG don't run inside `<img>`), **but** an SVG can carry `<script>`/`onload` handlers that execute if that stored logo is ever (a) served as a top-level document, (b) inlined into the DOM, or (c) opened directly by a user. Brand logos are composited and re-served, so this is a realistic stored-XSS path.

**Fix:** Drop SVG from the accepted types and add a client-side size guard. (The authoritative defense is server-side sanitization/validation — see note.)

```tsx
// BEFORE (line 16)
const ACCEPTED_TYPES = "image/png,image/jpeg,image/svg+xml,image/webp,image/gif";

// AFTER
const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";
const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB
```

```tsx
// In handleFile(), add at the very top (after the !brandId guard, ~line 39):
if (!ACCEPTED_TYPES.split(",").includes(file.type)) {
  toast({ title: "Unsupported file type", description: "Use PNG, JPEG, WebP, or GIF.", variant: "destructive" });
  return;
}
if (file.size > MAX_LOGO_BYTES) {
  toast({ title: "File too large", description: "Logos must be under 5 MB.", variant: "destructive" });
  return;
}
```

```tsx
// Update the helper text (line ~185)
// BEFORE: PNG, JPEG, SVG, WebP, or GIF
// AFTER:
<p className="text-xs text-muted-foreground mt-1">
  PNG, JPEG, WebP, or GIF (max 5 MB)
</p>
```

**Note for the server side:** The `/api/brands/:brandId/logos` endpoint must independently validate the MIME type and size — never trust the client. If SVG support is genuinely required, sanitize uploaded SVGs server-side (e.g. DOMPurify/`svg-sanitizer`) and serve them with `Content-Disposition: attachment` or from a separate, cookieless origin.

**Why:** SVG is an active-content format; accepting it unsanitized turns a logo upload into a script-injection channel.

---

### 3. 🟠 Calendar runs a data fetch inside `useMemo` (side-effect during render)

**Location:** `artifacts/sparqmake/src/pages/Calendar.tsx:143-145`

**Problem:** `useMemo` is for pure computation. Running `fetchEntries()` (which calls `setIsLoading`, `setEntries`, and performs network I/O) inside it is a side-effect during render. Under React 18 StrictMode / concurrent rendering this can double-invoke, fire at the wrong time, or tear state.

**Fix:** Use `useEffect`.

```tsx
// BEFORE (lines 143-145)
useMemo(() => {
  fetchEntries();
}, [fetchEntries]);

// AFTER
useEffect(() => {
  fetchEntries();
}, [fetchEntries]);
```

(`useEffect` is already imported in this file.)

**Why:** Effects, not memos, are the correct place for data fetching and state updates.

---

### 4. 🟠 CSS injection via font URL in an inline `<style>`

**Location:** `artifacts/sparqmake/src/pages/Settings.tsx:1171` (inside `BrandFontManagement` → font preview)

**Problem:** The font preview interpolates a stored URL straight into an inline stylesheet:

```tsx
<style>{`@font-face { font-family: 'preview-${font.id}'; src: url('${font.fileUrl}'); }`}</style>
```

If `font.fileUrl` ever contains attacker-influenced content, a crafted value (e.g. `x'); } body { display:none } @font-face { src:url('`) breaks out of the `url(...)` and injects arbitrary CSS into the page.

**Fix:** Load the preview font with the CSS Font Loading API and a validated/encoded URL, instead of string-building a `<style>` tag. Replace the inline `<style>` + `<p>` block with a small effect-driven component.

```tsx
// Add near the other imports
import { useEffect } from "react";

// New helper component (place above BrandFontManagement or in the same file)
function FontPreview({ fontId, fileUrl }: { fontId: string; fileUrl: string }) {
  const family = `preview-${fontId}`;
  useEffect(() => {
    let safeUrl: string;
    try {
      safeUrl = new URL(fileUrl, window.location.origin).href; // normalizes + percent-encodes
    } catch {
      return; // malformed URL → skip preview rather than inject
    }
    // JSON.stringify wraps in double quotes and escapes any embedded quotes,
    // so the value cannot break out of url(...)
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
```

```tsx
// BEFORE (line ~1169-1176)
{font.fileUrl && (
  <>
    <style>{`@font-face { font-family: 'preview-${font.id}'; src: url('${font.fileUrl}'); }`}</style>
    <p className="mt-2 text-sm" style={{ fontFamily: `'preview-${font.id}'` }}>
      The quick brown fox jumps over the lazy dog
    </p>
  </>
)}

// AFTER
{font.fileUrl && <FontPreview fontId={font.id} fileUrl={font.fileUrl} />}
```

**Why:** Building CSS by string concatenation from data is the same class of bug as building SQL/HTML by concatenation. The FontFace API + URL validation removes the injection surface entirely.

---

### 5. 🟠 Upload queue silently drops files dropped mid-upload (and corrupts state by index)

**Location:** `artifacts/sparqmake/src/pages/AssetLibrary.tsx:106-181`

**Problem:** Two coupled bugs:

1. `onDrop` calls `setUploadQueue(items)` (a **replace**) then `processQueue(items)`. If an upload is already running, `processQueue` early-returns on the `uploadActiveRef` guard — but the queue display was already clobbered and the newly dropped files are **never uploaded**.
2. `uploadOne` updates items by **array index** (`prev.map((p, i) => i === index ? ...)`). After a concurrent replace, indices no longer correspond to the items being uploaded, so status writes can land on the wrong rows.

**Fix:** Give each item a stable `id`, **append** to the queue instead of replacing, and have the drain loop pick up items that arrive mid-flight. Update by `id`, never index.

```tsx
// 1) Add a stable id to the item type (near line 90-97)
interface UploadItem {
  id: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}
```

```tsx
// 2) Replace processQueue (lines 106-168) — drain by id, re-check for late arrivals
const processQueue = useCallback(async () => {
  if (uploadActiveRef.current) return; // a drain loop is already running; it will pick up appended items
  uploadActiveRef.current = true;

  const brandId = selectedBrand !== "all" ? selectedBrand : (brands?.[0]?.id || "");
  const MAX_CONCURRENT = 3;
  let completed = 0;
  let failed = 0;

  const readPending = () =>
    new Promise<UploadItem[]>((resolve) => {
      setUploadQueue((prev) => {
        resolve(prev.filter((p) => p.status === "pending"));
        return prev;
      });
    });

  const uploadOne = async (item: UploadItem) => {
    setUploadQueue((prev) => prev.map((p) => (p.id === item.id ? { ...p, status: "uploading" } : p)));
    try {
      const formData = new FormData();
      formData.append("file", item.file);
      const uploadRes = await apiFetch(`${API_BASE}/api/upload`, { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const errData = await uploadRes.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(errData.error || `HTTP ${uploadRes.status}`);
      }
      const { url } = await uploadRes.json();
      const createRes = await apiFetch(`${API_BASE}/api/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId,
          type: "visual",
          name: item.file.name,
          status: "uploaded",
          fileUrl: url,
          thumbnailUrl: url,
          mimeType: item.file.type,
          fileSizeBytes: item.file.size,
          // uploadedBy intentionally omitted — server stamps it from the session (see finding #11)
          tags: [],
        }),
      });
      if (!createRes.ok) throw new Error("Failed to create asset record");
      completed++;
      setUploadQueue((prev) => prev.map((p) => (p.id === item.id ? { ...p, status: "done" } : p)));
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      setUploadQueue((prev) => prev.map((p) => (p.id === item.id ? { ...p, status: "error", error: message } : p)));
    }
  };

  let pending = await readPending();
  while (pending.length > 0) {
    for (let i = 0; i < pending.length; i += MAX_CONCURRENT) {
      const batch = pending.slice(i, i + MAX_CONCURRENT);
      await Promise.allSettled(batch.map(uploadOne));
    }
    pending = await readPending(); // pick up files dropped while we were uploading
  }

  queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
  uploadActiveRef.current = false;

  if (failed === 0) {
    toast({ title: `${completed} asset${completed !== 1 ? "s" : ""} uploaded successfully` });
  } else {
    toast({ variant: "destructive", title: `Upload complete: ${completed} succeeded, ${failed} failed` });
  }
}, [selectedBrand, brands, queryClient, toast]);
```

```tsx
// 3) onDrop now appends with stable ids and no longer passes the array (lines 170-175)
const onDrop = useCallback((acceptedFiles: File[]) => {
  if (acceptedFiles.length === 0) return;
  const items: UploadItem[] = acceptedFiles.map((file) => ({
    id: crypto.randomUUID(),
    file,
    status: "pending" as const,
  }));
  setUploadQueue((prev) => [...prev, ...items]);
  void processQueue();
}, [processQueue]);
```

**Why:** Appending + draining by stable id makes concurrent drops safe and eliminates index-based mis-writes; nothing is silently discarded.

---

### 6. 🟠 `isSubjectReference` treats every image as a subject reference

**Location:** `artifacts/sparqmake/src/pages/AssetLibrary.tsx:514`

**Problem:**

```tsx
const isSubjectReference = asset.assetClass === "subject_reference" || (asset.type === "image" || asset.mimeType?.startsWith("image/"));
```

The `||` with the image checks makes the flag `true` for **every** image asset, so the character-identity-note UI (lines ~508, 620, 641) shows for all images, not just actual subject references.

**Fix (strict — recommended):**

```tsx
const isSubjectReference = asset.assetClass === "subject_reference";
```

**Fix (if the intent was to also allow *unclassified* images to be tagged as subject references):**

```tsx
const isSubjectReference =
  asset.assetClass === "subject_reference" ||
  (!asset.assetClass && (asset.type === "image" || (asset.mimeType?.startsWith("image/") ?? false)));
```

Pick based on product intent — but the current unconditional `|| image` is logically too broad.

**Why:** A boolean meant to identify a specific asset class shouldn't be satisfied by an unrelated media-type check.

---

### 7. 🟠 Optimistic reschedule never re-syncs server-computed fields

**Location:** `artifacts/sparqmake/src/pages/Calendar.tsx:294-328`

**Problem:** `commitReschedule` optimistically mutates local `entries` and rolls back on `!resp.ok`, but on success it never refetches. Calendar entries are held in component state (not React Query), so any server-side recomputation on reschedule (e.g. clearing `smartScheduleRationale`, recomputing conflicts) won't be reflected until a full reload.

**Fix:** Add a silent reload after a successful PUT. Give `fetchEntries` an option to skip the loading flicker.

```tsx
// Update fetchEntries (line 108) to accept a silent flag
const fetchEntries = useCallback((opts?: { silent?: boolean }) => {
  // ...compute start/end...
  if (!opts?.silent) setIsLoading(true);
  // ...existing apiFetch(...).then(...).catch(...)...
}, [year, month, currentDate, brandFilter, viewMode]);
```

```tsx
// In commitReschedule, after the !resp.ok rollback block (after line 328):
  // re-sync to pick up any server-computed fields, without a loading flicker
  fetchEntries({ silent: true });
```

Add `fetchEntries` to `commitReschedule`'s dependency array.

**Why:** Optimistic UI should reconcile against the server once the write succeeds, so derived fields don't drift.

---

### 8. 🟠 `beforeunload` guard is unreliable across browsers

**Location:** `artifacts/sparqmake/src/hooks/useFormDirty.ts:31-33`

**Problem:** The handler only calls `e.preventDefault()`. Firefox and Safari require `e.returnValue` to be set for the native "unsaved changes" prompt to appear, so the guard is a no-op in those browsers.

**Fix:**

```tsx
// BEFORE (lines 31-33)
const handler = (e: BeforeUnloadEvent) => {
  e.preventDefault();
};

// AFTER
const handler = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = ""; // required by Firefox/Safari to trigger the prompt
};
```

**Why:** The cross-browser contract for `beforeunload` requires both `preventDefault()` and a `returnValue`.

---

### 9. 🟠 Keyless Fragment as the `.map()` root → React key warning

**Location:** `artifacts/sparqmake/src/components/ScheduleProfileEditor.tsx:274-295`

**Problem:** Each iteration returns a shorthand `<>...</>` Fragment, which cannot carry a `key`. React logs "Each child in a list should have a unique key" and reconciliation is less efficient (the inner children are keyed, but the per-row Fragment isn't).

**Fix:** Use a keyed `Fragment`.

```tsx
// Add to the react import at the top of the file
import { Fragment } from "react";

// BEFORE (line 274)
{DAYS.map((dayLabel, dayIndex) => (
  <>
    <div key={`label-${dayIndex}`} className="...">
      {dayLabel}
    </div>
    {HOURS.map(hour => { /* ... */ })}
  </>
))}

// AFTER
{DAYS.map((dayLabel, dayIndex) => (
  <Fragment key={dayIndex}>
    <div className="flex items-center text-xs font-medium text-muted-foreground pr-2 justify-end">
      {dayLabel}
    </div>
    {HOURS.map(hour => { /* ... unchanged, keep the button key={`${dayIndex}-${hour}`} ... */ })}
  </Fragment>
))}
```

(The inner `key` on the label `<div>` becomes redundant once the Fragment is keyed; the button keys must stay.)

**Why:** The keyed element must be the element returned by `.map()`, and a shorthand Fragment can't take a key.

---

### 10. 🟠 `FirstRunGuard` misroutes existing users to `/setup` on a fetch error

**Location:** `artifacts/sparqmake/src/App.tsx:68-98`

**Problem:** The guard fetches `/api/brands?limit=1`. On `.catch` it sets `loading = false` but leaves `brands = []`, so the subsequent `if (brands.length === 0) return <Redirect to="/setup" />` fires. A transient network failure or a 500 sends an established user into onboarding. It also doesn't check `res.ok`, so an error body is treated as data.

**Fix:** Track an error state and only redirect when we *know* there are zero brands.

```tsx
function FirstRunGuard({ children }: { children: React.ReactNode }) {
  const [brands, setBrands] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    apiFetch("/api/brands?limit=1", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setBrands(data.data || data || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load brands:", err);
        setErrored(true);   // ← don't assume "no brands"
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Redirect to onboarding only when the fetch succeeded AND returned no brands.
  if (!errored && brands.length === 0) {
    return <Redirect to="/setup" />;
  }

  return <>{children}</>;
}
```

**Why:** "Couldn't load brands" and "user has no brands" are different states; only the latter should trigger onboarding.

---

### 11. 🟠 `uploadedBy: "current_user"` placeholder written to the database

**Location:** `artifacts/sparqmake/src/pages/AssetLibrary.tsx:138` and `:757` · `artifacts/sparqmake/src/pages/Settings.tsx:1061`

**Problem:** The literal string `"current_user"` is persisted as the uploader on every asset/font create. This is meaningless data and can't be used for attribution or filtering.

**Fix (recommended):** Omit `uploadedBy` from all three client payloads and have the API stamp it from the authenticated session. The client should not assert its own identity for an audit field.

```tsx
// In each create payload, delete this line:
uploadedBy: "current_user",
```

Then, server-side, set `uploadedBy` (or `uploadedById`) from `req.session.user.id` when creating the asset.

**Alternative (if you must set it client-side):** use the real id from `useAuth()` — `const { user } = useAuth();` then `uploadedBy: user?.id`. Server-stamping is preferred because it can't be spoofed.

**Why:** Audit/ownership fields should come from the authenticated session, never a hardcoded client constant.

---

### 12. 🟠 Login: unvalidated `returnTo` + inconsistent API base

**Location:** `artifacts/sparqmake/src/pages/Login.tsx:1-5`

**Problem:** Two issues:
1. `returnTo` is read from the URL and forwarded to `/api/auth/google?returnTo=…` unvalidated. The frontend navigation itself stays same-origin, but it hands an attacker-controlled redirect target to the backend (open-redirect after OAuth).
2. This is the only place that **omits** the `VITE_API_URL` prefix that `useAuth` and `Settings` (`handleConnect`) use — it will break on a split-origin deployment.

**Fix:** Add the API base, sanitize `returnTo` to same-origin relative paths, and read the query string once.

```tsx
const API_BASE = import.meta.env.VITE_API_URL || "";

function sanitizeReturnTo(raw: string | null): string {
  // Allow only same-origin relative paths; reject absolute or protocol-relative URLs
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default function Login() {
  const params = new URLSearchParams(window.location.search);
  const returnTo = sanitizeReturnTo(params.get("returnTo"));
  const authError = params.get("error");

  const handleGoogleSignIn = () => {
    window.location.href = `${API_BASE}/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
  };

  // ...JSX unchanged, except use the `authError` variable instead of re-reading
  //    window.location.search a third time for the error message.
}
```

**Note for the server side:** The backend that consumes `returnTo` must **also** allow-list it (relative path, or an explicit set of allowed origins) before redirecting — client-side sanitization is defense-in-depth, not the authoritative control.

**Why:** Unvalidated redirect targets are an open-redirect/phishing vector, and an inconsistent API base silently breaks split-origin deploys.

---

### 13. 🟡 Brand update spreads the entire entity into the payload

**Location:** `artifacts/sparqmake/src/pages/Settings.tsx:606-615` (`BrandEditor.onSubmit`)

**Problem:** `updateBrandMutation.mutate({ id, data: { ...brand, ...data, ... } })` spreads the whole `brand` object — including server-managed fields like `id`, `createdAt`, `updatedAt`, `userId` — back into the update body. At best the server ignores them; at worst stale values are echoed back.

**Fix:** Send only the editable fields (explicit allow-list).

```tsx
const onSubmit = (data: Record<string, string>) => {
  try {
    const parsedPlatformRules = JSON.parse(data.platformRules);
    const parsedHashtagStrategy = JSON.parse(data.hashtagStrategy);
    const bannedTermsArray = data.bannedTerms.split(",").map((s) => s.trim()).filter(Boolean);

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
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    toast({ variant: "destructive", title: "Invalid JSON", description: message });
  }
};
```

**Why:** Update payloads should carry only what the user can edit; echoing server-managed fields is a correctness/security smell.

---

### 14. 🟡 `reset()` duplicates the `defaultValues` field mapping

**Location:** `artifacts/sparqmake/src/pages/Settings.tsx:566-582` vs `:524-540`

**Problem:** The `reset(...)` call in the mutation's `onSuccess` re-maps every form field by hand, duplicating the `defaultValues` object. Any field added in one place but not the other will silently fail to clear the "unsaved changes" banner.

**Fix:** Extract one mapping function and reset from the authoritative server response.

```tsx
// Single source of truth for form values
function brandToFormValues(b: Brand) {
  return {
    name: b.name,
    slug: b.slug,
    colorPrimary: b.colorPrimary,
    colorSecondary: b.colorSecondary,
    colorAccent: b.colorAccent,
    colorBackground: b.colorBackground,
    voiceDescription: b.voiceDescription || "",
    timezone: ((b as Record<string, unknown>).timezone as string) || "America/New_York",
    characterStyleRules: b.characterStyleRules || "",
    imagenPrefix: b.imagenPrefix || "",
    negativePrompt: b.negativePrompt || "",
    bannedTerms: b.bannedTerms?.join(", ") || "",
    trademarkRules: b.trademarkRules || "",
    platformRules: JSON.stringify(b.platformRules || {}, null, 2),
    hashtagStrategy: JSON.stringify(b.hashtagStrategy || {}, null, 2),
  };
}

// useForm
const { register, handleSubmit, reset, watch, setValue, formState: { isDirty } } =
  useForm({ defaultValues: brandToFormValues(brand) });

// onSuccess — reset from the server's returned brand (clears dirty, stays in sync)
onSuccess: (updated) => {
  queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
  queryClient.invalidateQueries({ queryKey: ["brand-readiness", brand.id] });
  toast({ title: "Brand updated successfully" });
  reset(brandToFormValues(updated as Brand));
},
```

If the update endpoint does **not** return the full updated brand, fall back to `reset(brandToFormValues({ ...brand, ...(variables.data as Partial<Brand>) }))`.

**Why:** One mapping function eliminates the drift risk between `defaultValues` and `reset`.

---

### 15. 🟡 `timezone` accessed via a type cast (missing from the generated type)

**Location:** `artifacts/sparqmake/src/pages/Settings.tsx:532` and `:574`

**Problem:** `(brand as Record<string, unknown>).timezone` is a cast hack indicating the generated `Brand` type (from `@workspace/api-client-react`) is missing the `timezone` field. This defeats type-checking on a real field.

**Fix:** Regenerate the Orval client so `Brand` includes `timezone` (update the OpenAPI spec / run the codegen step), then drop the cast:

```tsx
timezone: brand.timezone || "America/New_York",
```

In the meantime, the cast is now isolated to `brandToFormValues` (finding #14), so there's only one place to clean up once the type is regenerated.

**Why:** Casting away the type on a legitimate field hides future schema drift.

---

### 16. 🟡 Dropzones lack client-side type/size validation

**Location:** `artifacts/sparqmake/src/pages/AssetLibrary.tsx:181` (and the logo dropzone covered in #2)

**Problem:** `useDropzone({ onDrop, noClick: false, multiple: true })` accepts any file of any size, despite the UI implying "JPG, PNG, MP4". Oversized or wrong-type files fail only after a round-trip to the server.

**Fix:** Constrain the dropzone and surface rejections.

```tsx
const { getRootProps, getInputProps, isDragActive, open: openDropzone } = useDropzone({
  onDrop,
  noClick: false,
  multiple: true,
  accept: { "image/*": [], "video/mp4": [".mp4"] },
  maxSize: 50 * 1024 * 1024, // 50 MB — tune to your backend limit
  onDropRejected: (rejections) => {
    toast({
      variant: "destructive",
      title: "Some files were rejected",
      description: rejections.map((r) => r.file.name).join(", "),
    });
  },
});
```

**Why:** Failing fast on the client is cheaper and clearer than a server round-trip, and keeps the UI honest about what's accepted.

---

## Investigated — NOT a bug (do not "fix" these)

These were checked during review and are correct. Changing them will introduce regressions or wasted effort.

| Claim | Verdict | Evidence |
|-------|---------|----------|
| "Mutations are missing a CSRF token" | **Correct as-is** | The backend CSRF strategy is an **Origin/Referer allow-list**, not a token. The cookie-session client correctly sends no token. Adding one does nothing. |
| "Hand-written invalidation keys (`["/api/assets"]`, `["/api/brands"]`) don't match the generated query keys" | **Correct as-is** | Orval generates keys shaped like `[`/api/assets`, params]`, and TanStack Query invalidation is **prefix-matching** by default, so `["/api/assets"]` correctly invalidates all `/api/assets` queries. |
| Calendar "now" indicator hidden when `h > HOUR_END` looks off-by-one | **Correct as-is** | `HOUR_END = 22` and hour `22` is a rendered row (`HOURS` = 8…22 inclusive); only hour `23` should be hidden, which is exactly what `h > 22` does. |
| `Login.tsx` frontend navigation is an open redirect | **Frontend nav is same-origin** | The `window.location.href` target is always `/api/auth/...` (same origin). The redirect risk is in the **backend's** post-OAuth handling of `returnTo` — see finding #12's server note. |

---

## What looks good

- **Data-layer hygiene:** generated TanStack hooks for reads/mutations; `apiFetch` only for endpoints without generated hooks. `refetchOnWindowFocus: false` + 5-min `staleTime` are sensible defaults (`App.tsx:24-31`).
- **CSRF model is correctly matched** between client and the Origin/Referer-based server.
- **Cache invalidation works** via TanStack's prefix matching.
- **Good UX scaffolding:** consistent loading skeletons, `confirm()` guards on destructive actions, and `key={activeBrand.id}` to remount the editor on brand switch for a clean form reset (`Settings.tsx:252`).
- `Settings.tsx` `handleConnect` (line 308) correctly uses the `VITE_API_URL` base and only passes hardcoded platform ids — no injection there.
- The generated `custom-fetch.ts` mutator is robust and well-typed.

---

## Verdict

**Request Changes.** No release-blocking holes, but **findings #1 (calendar timezone) and #2 (SVG upload) should be fixed before shipping**, and **#3 / #8 / #9 / #10** will surface as flaky behavior under React 18 StrictMode or in non-Chromium browsers. Findings #11–#16 are safe to batch into a follow-up PR.

**Suggested order of work:**
1. **Ship-blockers:** #1, #2
2. **Correctness under StrictMode/browsers:** #3, #5, #6, #7, #8, #9, #10
3. **Security/consistency hardening:** #4, #12 (plus the server-side notes in #2, #11, #12)
4. **Cleanup:** #11, #13, #14, #15, #16
