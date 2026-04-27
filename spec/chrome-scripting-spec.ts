import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'

describe.skip('chrome.scripting dynamic content scripts', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-scripting-dynamic',
  })

  it('registers, lists, and unregisters content scripts', async () => {
    await browser.crx.exec('scripting.unregisterContentScripts')

    await browser.crx.exec('scripting.registerContentScripts', [
      {
        id: 'dynamic-script-1',
        matches: [`${server.getUrl()}*`],
        js: ['dynamic-marker.js'],
        runAt: 'document_end',
      },
    ])

    const listed = await browser.crx.exec('scripting.getRegisteredContentScripts')
    expect(listed).to.be.an('array')
    expect(listed.some((s: any) => s.id === 'dynamic-script-1')).to.equal(true)

    await browser.crx.exec('scripting.unregisterContentScripts', { ids: ['dynamic-script-1'] })
    const after = await browser.crx.exec('scripting.getRegisteredContentScripts')
    expect(after.some((s: any) => s.id === 'dynamic-script-1')).to.equal(false)
  })

  it('injects registered script on matching navigation', async () => {
    await browser.crx.exec('scripting.unregisterContentScripts')
    await browser.crx.exec('scripting.registerContentScripts', [
      {
        id: 'dynamic-script-2',
        matches: [`${server.getUrl()}*`],
        js: ['dynamic-marker.js'],
        runAt: 'document_end',
      },
    ])

    const created = await browser.crx.exec('tabs.create', { url: `${server.getUrl()}dynamic` })
    await new Promise((resolve) => setTimeout(resolve, 200))

    const result = await browser.crx.exec('scripting.executeScript', {
      target: { tabId: created.id },
      func: '() => window.__pceDynamic || 0',
    })
    expect(result).to.be.an('array')
    expect(result[0]?.result).to.be.greaterThan(0)
  })
})
