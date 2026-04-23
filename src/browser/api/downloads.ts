import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type PersistedDownloadItem = {
  id: number
  extensionId: string
  url: string
  filename: string
  finalUrl: string
  mime: string
  startTime: string
  state: 'in_progress' | 'interrupted' | 'complete'
  bytesReceived: number
  totalBytes: number
  exists: boolean
  byExtensionId: string
  byExtensionName: string
}

type PersistedDownloadsState = {
  nextId: number
  items: PersistedDownloadItem[]
}

type PendingDownloadRequest = {
  extensionId: string
  id: number
}

const DOWNLOADS_STATE_NS = 'downloads'

export class DownloadsAPI {
  private nextId = 1
  private records = new Map<number, PersistedDownloadItem>()
  private pendingByUrl = new Map<string, PendingDownloadRequest[]>()
  private itemIdByDownloadItem = new WeakMap<Electron.DownloadItem, number>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    // Electron may classify 'downloads' as unknown in some manifests.
    // Avoid hard-failing calls so real-world extensions can still run.
    handle('downloads.download', this.download)
    handle('downloads.search', this.search)

    this.restore()
    this.observeSessionDownloads()
  }

  private restore() {
    const state = this.ctx.stateStore.getNamespace<PersistedDownloadsState>(DOWNLOADS_STATE_NS, {
      nextId: 1,
      items: [],
    })
    this.nextId = Math.max(1, Number(state?.nextId || 1))
    for (const item of state?.items || []) {
      if (!item || typeof item.id !== 'number') continue
      this.records.set(item.id, item)
    }
  }

  private persist() {
    const state: PersistedDownloadsState = {
      nextId: this.nextId,
      items: Array.from(this.records.values()),
    }
    this.ctx.stateStore.setNamespace(DOWNLOADS_STATE_NS, state)
    void this.ctx.stateStore.flush().catch(() => {})
  }

  private observeSessionDownloads() {
    this.ctx.session.on('will-download', (_event, item) => {
      const url = item.getURL()
      const pending = this.consumePending(url)
      if (!pending) return
      const { extensionId, id } = pending

      const extension = (this.ctx.session.extensions || this.ctx.session).getExtension(extensionId)
      if (!extension) return

      this.itemIdByDownloadItem.set(item, id)

      const record: PersistedDownloadItem = {
        id,
        extensionId,
        url,
        filename: item.getFilename(),
        finalUrl: item.getURL(),
        mime: item.getMimeType() || '',
        startTime: new Date().toISOString(),
        state: 'in_progress',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        exists: true,
        byExtensionId: extensionId,
        byExtensionName: extension.name,
      }

      this.records.set(id, record)
      this.persist()
      this.ctx.router.sendEvent(extensionId, 'downloads.onCreated', { ...record })

      item.on('updated', () => {
        const previousState = record.state
        const previousBytes = record.bytesReceived
        record.bytesReceived = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        record.filename = item.getFilename()

        let nextState = previousState
        const itemState = item.getState()
        if (itemState === 'interrupted') nextState = 'interrupted'
        if (itemState === 'progressing' && !item.isPaused()) nextState = 'in_progress'
        record.state = nextState

        const delta: Record<string, any> = { id }
        if (record.state !== previousState) {
          delta.state = { previous: previousState, current: record.state }
        }
        if (record.bytesReceived !== previousBytes) {
          delta.bytesReceived = { previous: previousBytes, current: record.bytesReceived }
        }
        if (Object.keys(delta).length > 1) {
          this.ctx.router.sendEvent(extensionId, 'downloads.onChanged', delta)
        }
      })

      item.once('done', (_ev, doneState) => {
        const previousState = record.state
        if (doneState === 'completed') {
          record.state = 'complete'
        } else {
          record.state = 'interrupted'
        }
        record.bytesReceived = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        this.persist()
        this.ctx.router.sendEvent(extensionId, 'downloads.onChanged', {
          id,
          state: { previous: previousState, current: record.state },
          bytesReceived: { current: record.bytesReceived },
        })
      })
    })
  }

  private consumePending(url: string): PendingDownloadRequest | undefined {
    const queue = this.pendingByUrl.get(url)
    if (!queue || queue.length === 0) return undefined
    const pending = queue.shift()
    if (queue.length === 0) {
      this.pendingByUrl.delete(url)
    } else {
      this.pendingByUrl.set(url, queue)
    }
    return pending
  }

  private enqueuePending(url: string, pending: PendingDownloadRequest) {
    const queue = this.pendingByUrl.get(url) || []
    queue.push(pending)
    this.pendingByUrl.set(url, queue)
  }

  private download = async (
    { extension }: ExtensionEvent,
    options: chrome.downloads.DownloadOptions,
  ): Promise<number> => {
    const url = options?.url
    if (!url || typeof url !== 'string') {
      throw new Error('downloads.download requires a valid URL')
    }

    const id = this.nextId++
    this.enqueuePending(url, { extensionId: extension.id, id })
    const sessionAny = this.ctx.session as any
    if (typeof sessionAny.downloadURL === 'function') {
      sessionAny.downloadURL(url)
      this.persist()
      return id
    }

    throw new Error('downloads.download is not supported by this Electron session')
  }

  private search = async (
    { extension }: ExtensionEvent,
    query: chrome.downloads.DownloadQuery = {},
  ): Promise<PersistedDownloadItem[]> => {
    let items = Array.from(this.records.values()).filter((item) => item.extensionId === extension.id)

    if (typeof query.id === 'number') {
      items = items.filter((item) => item.id === query.id)
    }
    if (typeof query.state === 'string') {
      items = items.filter((item) => item.state === query.state)
    }
    if (typeof query.filename === 'string') {
      items = items.filter((item) => item.filename.includes(query.filename as string))
    }
    if (typeof query.url === 'string') {
      items = items.filter((item) => item.url.includes(query.url as string))
    }

    return items.map((item) => ({ ...item }))
  }
}
