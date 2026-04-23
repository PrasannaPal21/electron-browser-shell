import { expect } from 'chai'
import * as http from 'http'
import { AddressInfo } from 'net'

import { useExtensionBrowser } from './hooks'

describe('chrome.downloads', () => {
  let server: http.Server
  let downloadUrl = ''

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/file.txt') {
        const payload = 'downloads-test-file'
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(payload),
          'Content-Disposition': 'attachment; filename="file.txt"',
        })
        res.end(payload)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        downloadUrl = `http://127.0.0.1:${port}/file.txt`
        resolve()
      }),
    )
  })

  after(() => {
    server.close()
  })

  const browser = useExtensionBrowser({
    extensionName: 'chrome-downloads',
    url: () => 'https://example.com',
  })

  it('creates a download request', async () => {
    const id = await browser.crx.exec('downloads.download', { url: downloadUrl })
    expect(id).to.be.a('number')
  })

  it('search returns created download metadata', async () => {
    await browser.crx.exec('downloads.download', { url: downloadUrl })
    await new Promise<void>((resolve) => setTimeout(resolve, 75))
    const results = await browser.crx.exec('downloads.search', {})
    expect(results).to.be.an('array')
    expect(results.length).to.be.greaterThan(0)
    const hit = results.find((item: any) => item.url === downloadUrl)
    expect(hit).to.be.an('object')
  })
})
