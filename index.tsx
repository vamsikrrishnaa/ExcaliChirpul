import React, { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "@excalidraw/excalidraw/dist/excalidraw.min.css";
import "./CanvasRoot.scss";

import type * as TExcalidraw from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types/types";

declare global {
  interface Window {
    ExcalidrawLib: typeof TExcalidraw;
  }
}

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
const { Excalidraw } = window.ExcalidrawLib;

const BACKEND_URL = (import.meta as any).env?.VITE_CANVAS_BACKEND_URL || window.location.origin;

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  try {
    const escaped = name.replace(/[-[/{}()*+?.\\^$|]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function CanvasRoot() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);

  const projectId = searchParams.get("projectId") ?? undefined;
  const boardId = searchParams.get("boardId") ?? "default";
  const backendParam = searchParams.get("backend") ?? undefined;
  const modeParam = searchParams.get("mode"); // "view" | "edit" | null
  const themeParam = searchParams.get("theme"); // "light" | "dark" | null
  const zenParam = searchParams.get("zen"); // "1" to enable
  const gridParam = searchParams.get("grid"); // "1" to enable
  const controlsParam = searchParams.get("controls"); // "1" to show owner controls

  const [viewModeEnabled, setViewModeEnabled] = useState(modeParam === "view");
  const [zenModeEnabled, setZenModeEnabled] = useState(zenParam === "1");
  const [gridModeEnabled, setGridModeEnabled] = useState(gridParam === "1");
  const [theme, setTheme] = useState<"light" | "dark">(
    themeParam === "dark" ? "dark" : "light",
  );

  const [initialData, setInitialData] = useState<any | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [libraryItems, setLibraryItems] = useState<LibraryItems | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [starredLibraryIds, setStarredLibraryIds] = useState<string[]>([]);

  const storageKey = useMemo(() => `connectedCanvas:${boardId}`, [boardId]);
  const apiBase = useMemo(() => {
    // Prefer an explicit backend origin from the parent window so that the
    // sandbox can always talk to the correct API host.
    const raw = backendParam || BACKEND_URL;
    try {
      const url = new URL(raw, window.location.origin);
      return url.origin;
    } catch {
      return BACKEND_URL;
    }
  }, [backendParam]);
  const libraryStorageKey = "chirpulBoard:libraries:v1";
  const libraryMetaStorageKey = "chirpulBoard:librariesMeta:v1";

  const saveTimer = useRef<number | null>(null);
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [excalidrawReady, setExcalidrawReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `${apiBase}/api/projects/${encodeURIComponent(projectId || "")}/boards/${encodeURIComponent(boardId)}`;
        const res = await fetch(url, { credentials: "include" });
        if (cancelled) return;
        if (res.ok) {
          const json = await res.json().catch(() => null);
          if (cancelled) return;
          let usedRemote = false;
          if (json?.data && typeof json.data === "object") {
            setInitialData(json.data);
            usedRemote = true;
          }
          if (json?.updatedAt) {
            setLastUpdated(String(json.updatedAt));
          }

          // If the backend has no data yet (e.g. first save failed or user lacks write perms),
          // fall back to any cached local copy so the board does not appear empty on reopen.
          if (usedRemote) {
            return;
          }
        }
      } catch {
        // ignore network/backend errors; board will start empty until a save succeeds
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, boardId, storageKey, apiBase]);

  // Whenever we have initialData and the Excalidraw API is ready, push the
  // saved scene into the canvas so reopening a board shows previous work.
  useEffect(() => {
    if (!initialData) return;
    if (!excalidrawReady) return;
    if (!excalidrawRef.current) return;
    try {
      excalidrawRef.current.updateScene(initialData);
    } catch {
      // ignore scene update errors; user can still draw on a fresh board
    }
  }, [initialData, excalidrawReady]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(libraryStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as LibraryItems;
        setLibraryItems(parsed);
        if (excalidrawRef.current) {
          excalidrawRef.current.updateLibrary({ libraryItems: parsed });
        }
      }
    } catch {
      // ignore malformed library cache
    }
    try {
      const metaRaw = window.localStorage.getItem(libraryMetaStorageKey);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw) as { starredIds?: string[] };
        if (Array.isArray(meta.starredIds)) {
          setStarredLibraryIds(meta.starredIds.map((id) => String(id)));
        }
      }
    } catch {
      // ignore malformed meta cache
    }
  }, [libraryStorageKey, libraryMetaStorageKey]);

  useEffect(() => {
    if (!libraryItems || !excalidrawRef.current) return;
    try {
      excalidrawRef.current.updateLibrary({ libraryItems });
    } catch {
      // ignore update errors
    }
  }, [libraryItems]);

  const handleChange = useCallback(
    (elements: any, appState: any, files: any) => {
      if (viewModeEnabled) return; // don't persist in pure view mode

      try {
        if (saveTimer.current != null) {
          window.clearTimeout(saveTimer.current);
        }
        saveTimer.current = window.setTimeout(async () => {
          saveTimer.current = null;
          try {
            if (!projectId) return;
            const url = `${apiBase}/api/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}`;
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            try {
              const csrfToken =
                getCookie("csrfToken") ||
                getCookie("csrf-token") ||
                getCookie("csrf_token");
              if (csrfToken) {
                headers["X-CSRF-Token"] = csrfToken;
              }
            } catch {
              // best-effort CSRF header; fall back to origin-based checks
            }

            setIsSaving(true);
            await fetch(url, {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify({ elements, appState, files }),
            })
              .then(async (res) => {
                if (res && res.ok) {
                  const json = await res.json().catch(() => null);
                  if (json?.updatedAt) {
                    setLastUpdated(String(json.updatedAt));
                  } else {
                    setLastUpdated(new Date().toISOString());
                  }
                }
              })
              .catch(() => undefined)
              .finally(() => {
                setIsSaving(false);
              });
          } catch {
            setIsSaving(false);
            // ignore network/backend errors; changes might not be saved
          }
        }, 1000);
      } catch {
        // ignore scheduling errors
      }
    },
    [storageKey, viewModeEnabled, projectId, boardId, apiBase],
  );

  const normalizedLibraries = useMemo(() => {
    if (!libraryItems) return [] as { id: string; label: string; haystack: string; isStarred: boolean }[];
    const items = libraryItems.map((item, index) => {
      const anyItem: any = item as any;
      const id = String(anyItem.id ?? index);
      let label = `Item ${index + 1}`;
      try {
        const textEl = (anyItem.elements || []).find(
          (el: any) => el && el.type === "text" && typeof el.text === "string" && el.text.trim(),
        );
        if (textEl?.text) {
          label = String(textEl.text).slice(0, 60);
        }
      } catch {
        // ignore
      }
      const haystack = label.toLowerCase();
      const isStarred = starredLibraryIds.includes(id);
      return { id, label, haystack, isStarred };
    });
    const q = libraryQuery.trim().toLowerCase();
    const filtered = q ? items.filter((i) => i.haystack.includes(q)) : items;
    filtered.sort((a, b) => Number(b.isStarred) - Number(a.isStarred));
    return filtered;
  }, [libraryItems, libraryQuery, starredLibraryIds]);

  const toggleStar = useCallback(
    (id: string) => {
      setStarredLibraryIds((prev) => {
        const exists = prev.includes(id);
        const next = exists ? prev.filter((x) => x !== id) : [...prev, id];
        try {
          window.localStorage.setItem(
            libraryMetaStorageKey,
            JSON.stringify({ starredIds: next }),
          );
        } catch {
          // ignore
        }
        return next;
      });
    },
    [libraryMetaStorageKey],
  );

  const formatLastSaved = useCallback((value: string | null) => {
    if (!value) return "Not saved yet";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "Recently";
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "Recently";
    }
  }, []);

  return (
    <div className="chirpul-board-shell" data-theme={theme}>
      <div className="main-content">
        {libraryOpen && (
          <div className="assets-panel">
            <div className="panel-header">
              <span className="title">Assets</span>
              <span className="count">{normalizedLibraries.length}</span>
            </div>
            <input
              type="text"
              className="search-input"
              placeholder="Search assets..."
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
            />
            <div className="assets-list">
              {normalizedLibraries.length === 0 ? (
                <div className="empty-state">
                  No saved assets yet. Use the Excalidraw library to save items and
                  they will appear here.
                </div>
              ) : (
                normalizedLibraries.map((entry) => (
                  <div
                    key={entry.id}
                    className="asset-item"
                    onClick={() => {
                      // Optional: click to insert? For now just selection visual
                    }}
                  >
                    <span className="asset-label" title={entry.label}>
                      {entry.label}
                    </span>
                    <button
                      type="button"
                      className={`star-btn ${entry.isStarred ? "starred" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar(entry.id);
                      }}
                    >
                      ★
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        <div className="canvas-area">
          {/* Watermark top-left */}
          <div className="watermark">
            <span className="brand">Chirpul Board</span>
            <span className="context">
              {projectId ? "Linked to project" : "Standalone board"}
            </span>
          </div>

          {/* Controls top-right */}
          <div className="controls-bar">
            <button
              type="button"
              className={`control-btn ${libraryOpen ? "active" : ""}`}
              onClick={() => setLibraryOpen((open) => !open)}
            >
              {libraryOpen ? "Hide assets" : "Assets"}
            </button>
            {controlsParam === "1" ? (
              <>
                <span
                  className={`status-badge ${
                    viewModeEnabled ? "view-only" : "editable"
                  }`}
                >
                  {viewModeEnabled ? "View only" : "Editable"}
                </span>
                <button
                  type="button"
                  className="control-btn"
                  onClick={() => setViewModeEnabled((v) => !v)}
                >
                  {viewModeEnabled ? "Switch to edit" : "Switch to view"}
                </button>
                <button
                  type="button"
                  className={`control-btn ${zenModeEnabled ? "active" : ""}`}
                  onClick={() => setZenModeEnabled((z) => !z)}
                >
                  Focus
                </button>
                <button
                  type="button"
                  className={`control-btn ${gridModeEnabled ? "active" : ""}`}
                  onClick={() => setGridModeEnabled((g) => !g)}
                >
                  Grid
                </button>
                <button
                  type="button"
                  className="control-btn"
                  onClick={() => setTheme(theme === "light" ? "dark" : "light")}
                >
                  {theme === "light" ? "Dark" : "Light"} theme
                </button>
              </>
            ) : null}
          </div>

          <Excalidraw
            excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
              excalidrawRef.current = api;
              setExcalidrawReady(true);
              if (libraryItems) {
                try {
                  api.updateLibrary({ libraryItems });
                } catch {
                  // ignore update errors
                }
              }
            }}
            initialData={initialData || undefined}
            onChange={handleChange}
            viewModeEnabled={viewModeEnabled}
            zenModeEnabled={zenModeEnabled}
            gridModeEnabled={gridModeEnabled}
            theme={theme}
          />
        </div>
      </div>

      {/* Last-saved footer */}
      <div className={`footer-status ${isSaving ? "saving" : ""}`}>
        {isSaving ? "Saving…" : `Last saved · ${formatLastSaved(lastUpdated)}`}
      </div>
    </div>
  );
}

root.render(
  <StrictMode>
    <CanvasRoot />
  </StrictMode>,
);
