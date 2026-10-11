import { contextBridge, ipcRenderer } from 'electron'
import type { MathApi } from '@shared/api'

const api: MathApi = {
  spaceList: () => ipcRenderer.invoke('space:list'),
  spaceCreate: input => ipcRenderer.invoke('space:create', input),
  spaceUpdate: (id, patch) => ipcRenderer.invoke('space:update', { id, patch }),
  assignSpace: (entity, id, spaceId) => ipcRenderer.invoke('space:assign', { entity, id, spaceId }),
  dialogOpenDocuments: () => ipcRenderer.invoke('dlg:openDocuments'),
  docReadHtml: id => ipcRenderer.invoke('doc:readHtml', id),
  docUpdate: (id, patch) => ipcRenderer.invoke('doc:update', { id, patch }),
  appVersion: () => ipcRenderer.invoke('app:version'),
  appVersionInfo: () => ipcRenderer.invoke('app:versionInfo'),
  settingsLibraryInfo: () => ipcRenderer.invoke('settings:libraryInfo'),
  settingsChooseLibraryRoot: () => ipcRenderer.invoke('settings:chooseLibraryRoot'),
  settingsResetLibraryRoot: () => ipcRenderer.invoke('settings:resetLibraryRoot'),
  appRelaunch: () => ipcRenderer.invoke('app:relaunch'),
  importInfo: () => ipcRenderer.invoke('import:info'),
  importOpenExtensionDir: () => ipcRenderer.invoke('import:openExtensionDir'),
  prefGet: (key) => ipcRenderer.invoke('pref:get', key),
  prefSet: (key, value) => ipcRenderer.invoke('pref:set', { key, value }),
  dialogOpenPdf: () => ipcRenderer.invoke('dlg:openPdf'),
  dialogOpenImages: () => ipcRenderer.invoke('dlg:openImages'),
  docImport: (paths, options) => ipcRenderer.invoke('doc:import', { paths, options }),
  docList: spaceId => ipcRenderer.invoke('doc:list', spaceId),
  docOpen: (documentId) => ipcRenderer.invoke('doc:open', documentId),
  docSetMeta: (versionId, meta) => ipcRenderer.invoke('doc:meta', { versionId, ...meta }),
  anchorCreate: (input) => ipcRenderer.invoke('anchor:create', input),
  anchorGet: (anchorId) => ipcRenderer.invoke('anchor:get', anchorId),
  anchorListPage: (versionId, pageIndex) => ipcRenderer.invoke('anchor:listPage', { versionId, pageIndex }),
  inkGet: (versionId, pageIndex) => ipcRenderer.invoke('ink:get', { versionId, pageIndex }),
  inkSave: (versionId, pageIndex, strokes) => ipcRenderer.invoke('ink:save', { versionId, pageIndex, strokes }),
  paperFeedList: () => ipcRenderer.invoke('paper:feedList'),
  paperFeedCreate: (input) => ipcRenderer.invoke('paper:feedCreate', input),
  paperFeedUpdate: (id, patch) => ipcRenderer.invoke('paper:feedUpdate', { id, patch }),
  paperFeedDelete: (id) => ipcRenderer.invoke('paper:feedDelete', id),
  paperRefresh: (feedId) => ipcRenderer.invoke('paper:refresh', feedId ?? null),
  paperList: (status, days) => ipcRenderer.invoke('paper:list', { status, days }),
  paperImport: (arxivId, spaceId) => ipcRenderer.invoke('paper:import', { arxivId, spaceId }),
  paperSetStatus: (arxivId, status) => ipcRenderer.invoke('paper:setStatus', { arxivId, status }),
  paperOpenAbs: (arxivId) => ipcRenderer.invoke('paper:openAbs', arxivId),
  paperImportDaily: () => ipcRenderer.invoke('paper:importDaily'),
  paperDailySettings: () => ipcRenderer.invoke('paper:dailySettings'),
  paperSetDailySettings: (patch) => ipcRenderer.invoke('paper:setDailySettings', patch),
  testDeepLink: (url) => ipcRenderer.send('test:deepLink', url),
  testQuickCapture: () => ipcRenderer.send('test:quickCapture'),
  paperRevealFolder: () => ipcRenderer.invoke('paper:revealFolder'),
  noteCreate: (input) => ipcRenderer.invoke('note:create', input),
  noteGet: (noteId) => ipcRenderer.invoke('note:get', noteId),
  noteSave: (input) => ipcRenderer.invoke('note:save', input),
  noteSaveAsCopy: (input) => ipcRenderer.invoke('note:saveAsCopy', input),
  noteList: (query, spaceId) => ipcRenderer.invoke('notes:list', { query, spaceId }),
  activityPanel: (input) => ipcRenderer.invoke('activity:panel', input),
  activityRecordSession: (input) => ipcRenderer.invoke('activity:recordSession', input),
  noteAttachAnchor: (noteId, anchorId) => ipcRenderer.invoke('note:attachAnchor', { noteId, anchorId }),
  noteAttachCapture: (noteId, captureId) => ipcRenderer.invoke('note:attachCapture', { noteId, captureId }),
  noteBacklinks: (noteId) => ipcRenderer.invoke('note:backlinks', noteId),
  noteLinkIndex: () => ipcRenderer.invoke('note:linkIndex'),
  questionAggregate: (noteId) => ipcRenderer.invoke('question:aggregate', noteId),
  noteImageAdd: (data, fileName) => ipcRenderer.invoke('note:imageAdd', { data, fileName }),
  appOpenExternal: (url) => ipcRenderer.invoke('app:openExternal', { url }),
  notesForDocument: (documentId, opts) => ipcRenderer.invoke('notes:forDocument', { documentId, opts }),
  anchorCreateWithNote: (input) => ipcRenderer.invoke('anchor:createWithNote', input),
  captureImport: (paths, context, spaceId) => ipcRenderer.invoke('capture:import', { paths, context, spaceId }),
  captureList: filter => ipcRenderer.invoke('capture:list', filter ?? null),
  captureSave: (id, patch) => ipcRenderer.invoke('capture:save', { id, ...patch }),
  memoCreate: (input) => ipcRenderer.invoke('memo:create', input),
  memoList: (filter) => ipcRenderer.invoke('memo:list', filter ?? null),
  memoSave: (id, patch) => ipcRenderer.invoke('memo:save', { id, ...patch }),
  memoDelete: (id) => ipcRenderer.invoke('memo:delete', id),
  memoToNote: (id, input) => ipcRenderer.invoke('memo:toNote', { id, ...(input ?? {}) }),
  search: (q, spaceId) => ipcRenderer.invoke('search', { q, spaceId }),
  librarySearch: (query) => ipcRenderer.invoke('library:search', query),
  librarySections: () => ipcRenderer.invoke('library:sections'),
  libraryConflicts: () => ipcRenderer.invoke('library:conflicts'),
  libraryDiagnostics: () => ipcRenderer.invoke('library:diagnostics'),
  libraryEntryGet: (id) => ipcRenderer.invoke('library:entryGet', id),
  libraryImportUnfiled: (fileRel) => ipcRenderer.invoke('library:importUnfiled', { fileRel }),
  libraryFulltextRebuild: () => ipcRenderer.invoke('library:fulltextRebuild'),
  libraryFulltextStatus: (id) => ipcRenderer.invoke('library:fulltextStatus', id),
  libraryEntryUpdate: (id, patch) => ipcRenderer.invoke('library:updateEntry', { id, patch }),
  libraryEntryMove: (id, section) => ipcRenderer.invoke('library:move', { id, section }),
  librarySectionCreate: (name) => ipcRenderer.invoke('library:sectionCreate', { name }),
  librarySectionRename: (oldName, newName) => ipcRenderer.invoke('library:sectionRename', { oldName, newName }),
  librarySectionDelete: (name) => ipcRenderer.invoke('library:sectionDelete', { name }),
  librarySectionColor: (name, color) => ipcRenderer.invoke('library:sectionColor', { name, color }),
  libraryReveal: (id) => ipcRenderer.invoke('library:reveal', id),
  librarySectionReveal: (name) => ipcRenderer.invoke('library:revealSection', { name }),
  dialogOpenJsonFile: () => ipcRenderer.invoke('dlg:openJson'),
  dialogOpenDirectory: () => ipcRenderer.invoke('dlg:openDirectory'),
  zoteroImport: (jsonPath, storageDir) => ipcRenderer.invoke('zotero:import', { jsonPath, storageDir }),
  readingSave: (input) => ipcRenderer.invoke('reading:save', input),
  readingWorkspaceGet: documentId => ipcRenderer.invoke('reading:workspaceGet', documentId),
  readingWorkspaceSave: input => ipcRenderer.invoke('reading:workspaceSave', input),
  readingLastDocument: () => ipcRenderer.invoke('reading:lastDocument'),
  readerFind: (versionId, query) => ipcRenderer.invoke('reader:find', { versionId, query }),
  onFlushRequest: (cb) => {
    const handler = () => {
      void Promise.resolve().then(cb).then(
        () => ipcRenderer.send('app:flushed'),
        error => ipcRenderer.send('app:flush-failed', error instanceof Error ? error.message : String(error))
      )
    }
    ipcRenderer.on('app:flush', handler)
    return () => ipcRenderer.off('app:flush', handler)
  },
  onDeepLink: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { kind: 'paper'; baseId: string }) => cb(payload)
    ipcRenderer.on('app:deep-link', handler)
    return () => ipcRenderer.off('app:deep-link', handler)
  },
  onLibraryChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { kinds: string[] }) => cb(payload)
    ipcRenderer.on('library:changed', handler)
    return () => ipcRenderer.off('library:changed', handler)
  },
  onNotice: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { message: string; kind: 'success' | 'error' | 'info' }) => cb(payload)
    ipcRenderer.on('app:notice', handler)
    return () => ipcRenderer.off('app:notice', handler)
  },
  onQuickCapture: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('memo:quick-capture', handler)
    return () => ipcRenderer.off('memo:quick-capture', handler)
  },
  notifyFlushed: () => ipcRenderer.send('app:flushed'),
  logToMain: (level: 'info' | 'warn' | 'error', scope: string, message: string) => {
    ipcRenderer.send('app:renderer-log', { level, scope, message })
  },
  testIpcFail: (input) => ipcRenderer.invoke('test:ipcFail', input),
  testLastExternalUrl: () => ipcRenderer.invoke('test:lastExternalUrl')
}

contextBridge.exposeInMainWorld('api', api)
