// pages/project/ProjectWhiteboards.jsx — collaborative whiteboards (Excalidraw)
import { useEffect, useRef, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plus, Trash2, Maximize2, Minimize2, Palette } from 'lucide-react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useUI } from '../../store/ui';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../store/auth';
import { useTheme } from '../../store/theme';
import { whiteboards as wbApi } from '../../lib/api';
import { joinWhiteboard, leaveWhiteboard, emitDraw, emitSaveWb, emitPointerUpdate } from '../../lib/socket';
import socket from '../../lib/socket';
import Button from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useScopedPresence } from '../../lib/hooks';
import PresenceBar from '../../components/ui/PresenceBar';
import s from '../../styles/modules/Whiteboards.module.css';

export default function ProjectWhiteboards() {
  const { workspaceId, projectId, project, canEdit } = useOutletContext();
  const { user } = useAuth();
  const { toast, confirm, sidebarOpen } = useUI();
  const themeKind = useTheme(s => s.getActive().kind);
  // Scoped presence: only people viewing the Whiteboards section right now.
  const online = useScopedPresence(project?._id ? `wb:${project._id}` : null);

  const [whiteboards, setWhiteboards] = useState([]);
  const [activeWb, setActiveWb] = useState(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [initialData, setInitialData] = useState(null);
  const [wbModal, setWbModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const elementsRef = useRef([]);
  const isRemoteUpdateRef = useRef(false);
  const isDrawingRef = useRef(false);
  const pendingUpdateRef = useRef(null);
  const drawThrottleRef = useRef(null);
  const pointerThrottleRef = useRef(null);
  const collaboratorsRef = useRef(new Map());
  const activeWbRef = useRef(null);
  const saveIntervalRef = useRef(null);

  activeWbRef.current = activeWb;

  // Merge helper: reconcile remote elements with local elements by version
  const mergeElements = useCallback((remoteElements) => {
    if (!excalidrawAPI) return;
    isRemoteUpdateRef.current = true;
    const localElements = excalidrawAPI.getSceneElements();

    const localMap = new Map(localElements.map(el => [el.id, el]));
    const nextElementsMap = new Map();

    // Keep whichever version is newer for each element
    for (const remoteEl of remoteElements) {
      const localEl = localMap.get(remoteEl.id);
      if (localEl && localEl.version > remoteEl.version) {
        nextElementsMap.set(localEl.id, localEl);
      } else {
        nextElementsMap.set(remoteEl.id, remoteEl);
      }
    }

    // Preserve local-only elements not present in remote
    for (const localEl of localElements) {
      if (!nextElementsMap.has(localEl.id)) {
        nextElementsMap.set(localEl.id, localEl);
      }
    }

    const mergedElements = Array.from(nextElementsMap.values());
    elementsRef.current = mergedElements;
    excalidrawAPI.updateScene({ elements: mergedElements });
    requestAnimationFrame(() => { isRemoteUpdateRef.current = false; });
  }, [excalidrawAPI]);

  const saveNow = useCallback((wbId) => {
    const id = wbId ?? activeWbRef.current?._id;
    if (!id || !elementsRef.current?.length) return;
    emitSaveWb({ whiteboardId: id, elements: elementsRef.current });
  }, []);

  // Load whiteboards for this project
  useEffect(() => {
    if (!workspaceId || !projectId) return;
    wbApi.list(workspaceId, projectId)
      .then(({ data }) => {
        const list = data.whiteboards ?? data ?? [];
        setWhiteboards(list);
        if (list.length && !activeWb) selectWb(list[0]);
      })
      .catch(() => setWhiteboards([]));
  }, [workspaceId, projectId]);

  // Join/leave room and auto-save
  useEffect(() => {
    if (!activeWb) return;
    joinWhiteboard(activeWb._id);
    saveIntervalRef.current = setInterval(() => {
      if (elementsRef.current?.length) {
        emitSaveWb({ whiteboardId: activeWb._id, elements: elementsRef.current });
      }
    }, 10_000);
    return () => {
      saveNow(activeWb._id);
      leaveWhiteboard(activeWb._id);
      if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
      if (drawThrottleRef.current) clearTimeout(drawThrottleRef.current);
    };
  }, [activeWb?._id, saveNow]);

  // Socket events
  useEffect(() => {
    // Full sync from server (initial load) — replace everything
    const onSync = (elements) => {
      if (!Array.isArray(elements)) return;
      isRemoteUpdateRef.current = true;
      elementsRef.current = elements;
      setInitialData({ elements, scrollToContent: true });
      if (excalidrawAPI) excalidrawAPI.updateScene({ elements });
      requestAnimationFrame(() => { isRemoteUpdateRef.current = false; });
    };

    // Incremental update from another user — merge, don't overwrite
    const onUpdate = (elements) => {
      if (!Array.isArray(elements)) return;
      if (!excalidrawAPI) return;

      // If user is actively drawing, buffer the update to prevent disruption
      if (isDrawingRef.current) {
        pendingUpdateRef.current = elements;
        return;
      }

      mergeElements(elements);
    };

    // Live collaborator cursors
    const onPointerUpdate = (data) => {
      const { socketId, pointer, button, user, color } = data;
      const baseColor = color || '#3498db';
      collaboratorsRef.current.set(socketId, {
        pointer,
        button,
        username: user || 'Anonymous',
        color: { background: baseColor, stroke: baseColor },
      });
      if (excalidrawAPI) {
        excalidrawAPI.updateScene({ collaborators: new Map(collaboratorsRef.current) });
      }
    };

    socket.on('whiteboard_sync', onSync);
    socket.on('whiteboard_update', onUpdate);
    socket.on('whiteboard_pointer_update', onPointerUpdate);
    return () => {
      socket.off('whiteboard_sync', onSync);
      socket.off('whiteboard_update', onUpdate);
      socket.off('whiteboard_pointer_update', onPointerUpdate);
    };
  }, [excalidrawAPI, mergeElements]);

  // Save on unmount
  useEffect(() => {
    return () => { saveNow(); };
  }, [saveNow]);

  // Escape key exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setIsFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const selectWb = (wb) => {
    if (activeWb?._id === wb._id) return;
    if (activeWb) {
      saveNow(activeWb._id);
      leaveWhiteboard(activeWb._id);
    }
    setActiveWb(wb);
    setInitialData(null);
    elementsRef.current = [];
    collaboratorsRef.current = new Map();
  };

  const onChange = useCallback((elements) => {
    elementsRef.current = elements;
    if (isRemoteUpdateRef.current || !activeWbRef.current) return;
    if (drawThrottleRef.current) clearTimeout(drawThrottleRef.current);
    drawThrottleRef.current = setTimeout(() => {
      const wbId = activeWbRef.current?._id;
      if (!wbId || isRemoteUpdateRef.current) return;
      emitDraw({ whiteboardId: wbId, elements: elementsRef.current });
    }, 50);
  }, []);

  const handlePointerUpdate = useCallback((payload) => {
    const wasDrawing = isDrawingRef.current;
    isDrawingRef.current = payload.button === 'down';

    // When user finishes drawing, flush any buffered remote updates
    if (wasDrawing && !isDrawingRef.current && pendingUpdateRef.current) {
      mergeElements(pendingUpdateRef.current);
      pendingUpdateRef.current = null;
    }

    if (!activeWbRef.current) return;
    if (pointerThrottleRef.current) return;

    pointerThrottleRef.current = setTimeout(() => {
      pointerThrottleRef.current = null;
    }, 40); // ~25fps

    emitPointerUpdate({
      whiteboardId: activeWbRef.current._id,
      pointer: payload.pointer,
      button: payload.button,
      user: user?.name,
    });
  }, [user?.name, mergeElements]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!canEdit) return toast('Read-only access', 'error');
    setCreating(true);
    try {
      const { data } = await wbApi.create(workspaceId, projectId, { name: newName || 'Untitled Whiteboard' });
      const wb = data.whiteboard ?? data;
      setWhiteboards(prev => [...prev, wb]);
      setNewName('');
      setWbModal(false);
      selectWb(wb);
      toast('Whiteboard created!', 'success');
    } catch (err) {
      toast(err?.response?.data?.message || 'Failed to create', 'error');
    } finally { setCreating(false); }
  };

  const handleDelete = async (wb) => {
    if (!(await confirm(`Delete "${wb.name}"?`))) return;
    try {
      await wbApi.delete(workspaceId, projectId, wb._id);
      const remaining = whiteboards.filter(w => w._id !== wb._id);
      setWhiteboards(remaining);
      if (activeWb?._id === wb._id) {
        if (remaining.length) selectWb(remaining[0]);
        else { setActiveWb(null); setInitialData(null); }
      }
      toast('Whiteboard deleted', 'info');
    } catch { toast('Failed to delete', 'error'); }
  };

  return (
    <div
      className={`${s.page} ${isFullscreen ? s.pageFullscreen : ''}`}
      style={isFullscreen ? { left: sidebarOpen ? '240px' : '0' } : undefined}
    >
      {!isFullscreen && (
        <div className={s.header}>
          <div>
            <h1 className={s.title}>Whiteboards</h1>
            <p className={s.subtitle}>Real-time collaborative canvas · {project?.name}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <PresenceBar users={online} size={28} label="here" />
            {canEdit && (
              <Button variant="primary" size="md" onClick={() => setWbModal(true)}>
                <Plus size={14} /> New Whiteboard
              </Button>
            )}
          </div>
        </div>
      )}

      <div className={`${s.body} ${isFullscreen ? s.bodyFullscreen : ''}`}>
        <div className={s.canvas}>
          {!activeWb ? (
            <div className={s.placeholder}>
              <Palette size={32} className={s.placeholderIcon} />
              <p>Select or create a whiteboard to get started</p>
              {canEdit && (
                <Button variant="primary" size="sm" onClick={() => setWbModal(true)}>
                  <Plus size={12} /> New Whiteboard
                </Button>
              )}
            </div>
          ) : (
            <>
              {!isFullscreen && (
                <div className={s.canvasHead}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <select
                      className={s.wbSelect}
                      value={activeWb._id}
                      onChange={(e) => {
                        const wb = whiteboards.find(w => w._id === e.target.value);
                        if (wb) selectWb(wb);
                      }}
                    >
                      {whiteboards.map(wb => (
                        <option key={wb._id} value={wb._id}>{wb.name}</option>
                      ))}
                    </select>
                    {canEdit && (
                      <button className={s.deleteBtn} onClick={() => handleDelete(activeWb)} title="Delete Whiteboard">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className={s.canvasMeta}>● Live · Auto-save 10s</span>
                    <button
                      className={s.fullscreenBtn}
                      onClick={() => setIsFullscreen(true)}
                      title="Enter fullscreen"
                    >
                      <Maximize2 size={14} />
                    </button>
                  </div>
                </div>
              )}

              {isFullscreen && (
                <>
                  <div className={s.overlayLeft}>
                    <select
                      className={s.wbSelectFullscreen}
                      value={activeWb._id}
                      onChange={(e) => {
                        const wb = whiteboards.find(w => w._id === e.target.value);
                        if (wb) selectWb(wb);
                      }}
                    >
                      {whiteboards.map(wb => (
                        <option key={wb._id} value={wb._id}>{wb.name}</option>
                      ))}
                    </select>
                    {canEdit && (
                      <button className={s.deleteBtn} onClick={() => handleDelete(activeWb)} title="Delete Whiteboard">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  <div className={s.overlayControls}>
                    <PresenceBar users={online} size={24} label="here" />
                    {canEdit && (
                      <Button variant="primary" size="sm" onClick={() => setWbModal(true)}>
                        <Plus size={12} /> New Whiteboard
                      </Button>
                    )}
                    <button
                      className={s.fullscreenBtn}
                      onClick={() => setIsFullscreen(false)}
                      title="Exit fullscreen"
                    >
                      <Minimize2 size={14} />
                    </button>
                  </div>
                </>
              )}

              <div className={`${s.canvasArea} ${isFullscreen ? s.canvasAreaFullscreen : ''}`}>
                <Excalidraw
                  key={activeWb._id}
                  excalidrawAPI={(api) => setExcalidrawAPI(api)}
                  initialData={initialData ?? { elements: elementsRef.current, scrollToContent: false }}
                  onChange={onChange}
                  onPointerUpdate={handlePointerUpdate}
                  theme={themeKind}
                  viewModeEnabled={!canEdit}
                  UIOptions={{
                    canvasActions: {
                      saveToActiveFile: false,
                      loadScene: false,
                      export: false,
                    },
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {wbModal && (
        <div className={s.modalOverlay} onClick={() => setWbModal(false)}>
          <div className={s.modal} onClick={e => e.stopPropagation()}>
            <h3 className={s.modalTitle}>New Whiteboard</h3>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Input
                label="Whiteboard name"
                placeholder="System Architecture"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                autoFocus
              />
              <div className={s.modalActions}>
                <Button type="button" variant="ghost" onClick={() => setWbModal(false)}>Cancel</Button>
                <Button type="submit" variant="primary" loading={creating}>Create</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}