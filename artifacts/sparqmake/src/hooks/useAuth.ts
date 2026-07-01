import { apiFetch } from "@/lib/utils";
import { useState, useEffect, useCallback, createContext, useContext, useRef } from "react";
import type { ReactNode } from "react";
import { createElement } from "react";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: string;
}

interface AuthState {
  authenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const API_BASE = import.meta.env.VITE_API_URL || "";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

async function fetchAuthWithRetry(attempt = 0): Promise<{ authenticated: boolean; user: AuthUser | null }> {
  try {
    const res = await apiFetch(`${API_BASE}/api/auth/me`, { credentials: "include" });
    if (!res.ok && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return fetchAuthWithRetry(attempt + 1);
    }
    const data = await res.json();
    return { authenticated: data.authenticated, user: data.user || null };
  } catch {
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return fetchAuthWithRetry(attempt + 1);
    }
    return { authenticated: false, user: null };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    user: null,
    loading: true,
  });
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const result = await fetchAuthWithRetry();
    if (mountedRef.current) {
      setState({ ...result, loading: false });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {}
    setState({ authenticated: false, user: null, loading: false });
    window.location.href = import.meta.env.BASE_URL + "login";
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  return createElement(
    AuthContext.Provider,
    { value: { ...state, refresh, logout } },
    children,
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

const WRITE_ROLES = new Set(["editor", "admin"]);

export function roleCanWrite(role: string | null | undefined): boolean {
  return !!role && WRITE_ROLES.has(role);
}

export function roleIsAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

/** True when the signed-in user may perform write actions (editor or admin). */
export function useCanWrite(): boolean {
  const { user } = useAuth();
  return roleCanWrite(user?.role);
}

/** True when the signed-in user is an admin. */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return roleIsAdmin(user?.role);
}
