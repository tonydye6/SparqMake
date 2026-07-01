import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  return fetch(url, { ...options, credentials: "include" as RequestCredentials });
}

/**
 * Detect a permission-denied (403) outcome from either a raw `Response`
 * (apiFetch handlers) or a thrown error (generated api-client mutations, which
 * throw an `ApiError` carrying a numeric `status`).
 */
export function isForbidden(source: unknown): boolean {
  if (source instanceof Response) return source.status === 403;
  if (source && typeof source === "object" && "status" in source) {
    return (source as { status?: unknown }).status === 403;
  }
  return false;
}

export const PERMISSION_DENIED_MESSAGE = "You don't have permission to do that";
