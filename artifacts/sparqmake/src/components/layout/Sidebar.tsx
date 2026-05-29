import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Library, 
  Calendar as CalendarIcon, 
  CheckSquare, 
  Settings,
  DollarSign,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Menu,
  X,
  ClipboardList,
  MessageSquareText
} from "lucide-react";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn, apiFetch } from "@/lib/utils";
import { useGetCreatives } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/useAuth";

type SidebarMode = "mobile" | "tablet" | "desktop";

function useResponsiveMode(): SidebarMode {
  const [mode, setMode] = useState<SidebarMode>(() => {
    if (typeof window === "undefined") return "desktop";
    if (window.innerWidth < 768) return "mobile";
    if (window.innerWidth < 1280) return "tablet";
    return "desktop";
  });

  useEffect(() => {
    const update = () => {
      if (window.innerWidth < 768) setMode("mobile");
      else if (window.innerWidth < 1280) setMode("tablet");
      else setMode("desktop");
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mode;
}

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const [location] = useLocation();
  const mode = useResponsiveMode();
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const { data: creatives } = useGetCreatives();
  const [calendarCount, setCalendarCount] = useState(0);
  const [pendingAssetCount, setPendingAssetCount] = useState(0);
  const { user, logout } = useAuth();

  const reviewCount = creatives?.data?.filter(c => c.status === "pending_review" || c.status === "in_review").length || 0;

  useEffect(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    apiFetch(`/api/calendar-entries?start=${start.toISOString()}&end=${end.toISOString()}`)
      .then(res => res.json())
      .then(data => setCalendarCount(Array.isArray(data) ? data.length : (data?.entries?.length ?? 0)))
      .catch((err) => console.error("Failed to load calendar count:", err));
  }, []);

  useEffect(() => {
    apiFetch("/api/assets?status=uploaded&limit=1")
      .then(res => res.json())
      .then(data => setPendingAssetCount(data.total || 0))
      .catch((err) => console.error("Failed to load asset count:", err));
  }, []);

  const NAV_ITEMS = [
    { href: "/", label: "Creative Studio", icon: LayoutDashboard },
    { href: "/assets", label: "Asset Library", icon: Library, badge: pendingAssetCount || undefined },
    { href: "/calendar", label: "Calendar", icon: CalendarIcon, badge: calendarCount || undefined },
    { href: "/content-plan", label: "Content Plan", icon: ClipboardList },
    { href: "/review", label: "Review Queue", icon: CheckSquare, badge: reviewCount || undefined },
    { href: "/costs", label: "Cost Dashboard", icon: DollarSign },
    { href: "/settings", label: "Settings", icon: Settings },
    { href: "/feedback", label: "Feedback", icon: MessageSquareText },
  ];

  const collapsed = mode === "tablet" ? !tabletExpanded : mode === "desktop" ? desktopCollapsed : false;
  const sidebarWidth = collapsed ? 64 : 220;

  const displayName = user?.name || user?.email || "User";
  const displayRole = user?.role || "viewer";
  const avatarUrl = user?.image || `${import.meta.env.BASE_URL}images/avatar.png`;

  const handleNavClick = () => {
    if (mode === "mobile") {
      onMobileClose();
    }
    if (mode === "tablet") {
      setTabletExpanded(false);
    }
  };

  const sidebarContent = (
    <motion.aside
      initial={false}
      animate={{ width: mode === "mobile" ? 280 : sidebarWidth }}
      className={cn(
        "h-screen flex flex-col bg-sidebar border-r border-sidebar-border relative z-20 shrink-0 transition-all duration-300 ease-in-out",
        mode === "mobile" && "w-[280px]"
      )}
    >
      <div className="h-16 flex items-center px-4 border-b border-sidebar-border shrink-0 overflow-hidden">
        <img 
          src={`${import.meta.env.BASE_URL}images/sparq-logo.png`} 
          alt="SparqMake Logo" 
          className="w-8 h-8 rounded shrink-0 object-cover"
        />
        {(mode === "mobile" || !collapsed) && (
          <span className="ml-3 font-display font-bold text-xl text-foreground whitespace-nowrap">
            SPARQ<span className="text-primary">MAKE</span>
          </span>
        )}
        {mode === "mobile" && (
          <button
            onClick={onMobileClose}
            className="ml-auto p-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
          >
            <X size={20} />
          </button>
        )}
      </div>

      {mode === "desktop" && (
        <button
          onClick={() => setDesktopCollapsed(!desktopCollapsed)}
          className="absolute -right-3 top-20 bg-card border border-border rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-accent hover:border-accent transition-colors z-50"
        >
          {desktopCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      )}

      {mode === "tablet" && (
        <button
          onClick={() => setTabletExpanded(!tabletExpanded)}
          className="absolute -right-3 top-20 bg-card border border-border rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-accent hover:border-accent transition-colors z-50"
        >
          {tabletExpanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      )}

      <nav className="flex-1 py-6 px-3 space-y-2 overflow-y-auto overflow-x-hidden">
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          const showLabel = mode === "mobile" || !collapsed;
          return (
            <Link 
              key={item.href} 
              href={item.href}
              onClick={handleNavClick}
              className={cn(
                "flex items-center px-3 py-3 rounded-lg transition-all duration-200 group relative",
                isActive 
                  ? "bg-primary/10 text-primary" 
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
              title={collapsed && mode !== "mobile" ? item.label : undefined}
            >
              {isActive && (
                <motion.div 
                  layoutId="activeNavIndicator"
                  className="absolute left-0 top-0 bottom-0 w-1 bg-primary rounded-r-full"
                  initial={false}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
              <item.icon size={20} className={cn("shrink-0", isActive && "text-primary")} />
              
              {showLabel && (
                <span className="ml-3 font-medium text-sm whitespace-nowrap flex-1">
                  {item.label}
                </span>
              )}

              {showLabel && item.badge && (
                <span className="ml-auto bg-primary/20 text-primary text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {item.badge}
                </span>
              )}
              
              {!showLabel && item.badge && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-sidebar-border shrink-0">
        <div className={cn("flex items-center", collapsed && mode !== "mobile" ? "justify-center" : "justify-between")}>
          <div className="flex items-center overflow-hidden">
            <img 
              src={avatarUrl}
              alt="User Avatar"
              className="w-9 h-9 rounded-full object-cover border border-border"
              referrerPolicy="no-referrer"
            />
            {(mode === "mobile" || !collapsed) && (
              <div className="ml-3 truncate">
                <p className="text-sm font-semibold text-foreground truncate">{displayName}</p>
                <p className="text-xs text-muted-foreground truncate capitalize">{displayRole}</p>
              </div>
            )}
          </div>
          {(mode === "mobile" || !collapsed) && (
            <button
              onClick={logout}
              className="p-2 text-muted-foreground hover:text-destructive transition-colors rounded-md hover:bg-destructive/10"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </div>
    </motion.aside>
  );

  if (mode === "mobile") {
    return (
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-black/50 z-40"
              onClick={onMobileClose}
            />
            <motion.div
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed top-0 left-0 bottom-0 z-50"
            >
              {sidebarContent}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    );
  }

  return sidebarContent;
}

export function MobileTopBar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <div className="h-14 flex items-center px-4 bg-sidebar border-b border-sidebar-border shrink-0 md:hidden">
      <button
        onClick={onMenuClick}
        className="p-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
      >
        <Menu size={22} />
      </button>
      <img 
        src={`${import.meta.env.BASE_URL}images/sparq-logo.png`} 
        alt="SparqMake Logo" 
        className="w-7 h-7 rounded shrink-0 object-cover ml-3"
      />
      <span className="ml-2 font-display font-bold text-lg text-foreground whitespace-nowrap">
        SPARQ<span className="text-primary">MAKE</span>
      </span>
    </div>
  );
}
