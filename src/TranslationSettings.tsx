import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Eye, EyeOff, KeyRound, Languages, LoaderCircle } from 'lucide-react'
import { TRANSLATION_PROVIDER_NAMES, isTranslationModelProvider, normalizeTranslationConfiguration, type ConfigureTranslationRequest, type PublicTranslationSettings, type TranslationProvider } from '../shared/translation-settings'
import { PROVIDER_NAMES, type ProviderId } from '../shared/contracts'
import MenuSelect from './MenuSelect'
import ConnectionFeedback, { type ConnectionStatus } from './ConnectionFeedback'
import OfflineTranslationSetup from './OfflineTranslationSetup'

export default function TranslationSettings({ settings, chatProvider, chatConfigured, onConfigure }: {
  settings: PublicTranslationSettings; chatProvider: ProviderId; chatConfigured: boolean
  onConfigure: (request: ConfigureTranslationRequest) => Promise<void>
}) {
  const [provider, setProvider] = useState(settings.provider)
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [region, setRegion] = useState(settings.azure.region)
  const [model, setModel] = useState(isTranslationModelProvider(settings.provider) ? settings[settings.provider].model : '')
  const [action, setAction] = useState<'save' | 'remove' | 'test' | 'switch' | null>(null)
  const busy = action !== null
  const working = useRef(false)
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const savedModel = isTranslationModelProvider(settings.provider) ? settings[settings.provider].model : ''
  useEffect(() => { setProvider(settings.provider); setRegion(settings.azure.region); setModel(savedModel) }, [settings.provider, settings.azure.region, savedModel])
  const configured = provider === 'offline' || (provider === 'chat' ? chatConfigured : settings[provider].configured)
  const modelProvider = isTranslationModelProvider(provider)
  const modelChanged = modelProvider && model !== settings[provider].model
  const regionChanged = provider === 'azure' && region !== settings.azure.region
  const dirty = Boolean(key.trim()) || modelChanged || regionChanged
  const edit = () => setStatus(null)
  const begin = (next: NonNullable<typeof action>, message: string) => {
    if (working.current) return false
    working.current = true; setAction(next); setStatus({ tone: 'working', message }); return true
  }
  const finish = () => { working.current = false; setAction(null) }
  const draft = (clearKey = false) => normalizeTranslationConfiguration({ provider, ...(provider === 'azure' ? { region } : {}), ...(modelProvider && !clearKey ? { model } : {}), ...(clearKey ? { clearKey: true } : key.trim() ? { apiKey: key } : {}) })
  async function changeProvider(next: TranslationProvider) {
    if (next === provider || !begin('switch', `Switching to ${TRANSLATION_PROVIDER_NAMES[next]}…`)) return
    try { await onConfigure({ provider: next }); setProvider(next); setKey(''); setShow(false) }
    catch { setStatus({ tone: 'error', message: 'Could not change translation provider. Try again.' }); return }
    finally { finish() }
    setStatus(null)
  }
  async function save(event: FormEvent, clearKey = false) {
    event.preventDefault()
    if (!begin(clearKey ? 'remove' : 'save', clearKey ? 'Removing translation key…' : 'Saving translation settings…')) return
    try {
      const request = draft(clearKey)
      await onConfigure(request)
      setKey(''); setShow(false)
      setStatus({ tone: 'success', message: clearKey ? 'Translation key removed.' : 'Translation settings saved. Test the connection to verify access.' })
    } catch { setStatus({ tone: 'error', message: 'Could not save. Check the API key, model identifier, or Azure region, then try again.' }) }
    finally { finish() }
  }
  async function test() {
    if (!begin('test', dirty ? 'Saving your changes before testing…' : `Testing ${TRANSLATION_PROVIDER_NAMES[provider]} connection…`)) return
    try {
      const request = draft()
      if (!configured && !key.trim()) {
        setStatus({ tone: 'error', message: `Enter a ${TRANSLATION_PROVIDER_NAMES[provider]} translation API key first.` }); return
      }
      if (dirty) { await onConfigure(request); setKey(''); setShow(false) }
      setStatus({ tone: 'working', message: `Testing ${TRANSLATION_PROVIDER_NAMES[provider]} connection…` })
      const result = await window.studio!.testTranslation()
      setStatus({ tone: result.ok ? 'success' : 'error', message: result.ok ? `${TRANSLATION_PROVIDER_NAMES[provider]} connected. A sample translated successfully.` : result.message })
    } catch { setStatus({ tone: 'error', message: 'Connection test failed. Check your API key, model, region, and network, then try again.' }) }
    finally { finish() }
  }
  return <section className="settings-section translation-settings">
    <div className="settings-title"><span className="settings-icon"><Languages size={18} /></span><div><h2>Caption translation</h2><p>Choose translation separately from chat and speech recognition.</p></div><span className={`configured-badge ${configured ? 'on' : ''}`}><i />{provider === 'offline' ? 'Local' : configured ? 'Configured' : 'Key needed'}</span></div>
    <div className="connection-field">
      <label htmlFor="translation-provider">Translation provider</label>
      <MenuSelect id="translation-provider" ariaLabel="Translation provider" value={provider} disabled={busy} options={[{ value: 'offline', label: 'Offline (language packs)' }, { value: 'azure', label: 'Azure Translator' }, { value: 'google', label: 'Google Cloud Translation' }, { value: 'openrouter', label: 'OpenRouter' }, { value: 'openai', label: 'OpenAI' }, { value: 'nanogpt', label: 'NanoGPT' }, { value: 'chat', label: `Use chat connection (${PROVIDER_NAMES[chatProvider]})` }]} onChange={next => void changeProvider(next as TranslationProvider)} />
      <p>{provider === 'offline' ? 'Translate on this PC using downloaded language packs. No internet or key is used during translation.' : provider === 'azure' ? 'Azure offers an F0 free tier. Select F0 in Azure to use its free allowance; the app cannot determine your billing tier.' : provider === 'google' ? 'Uses Cloud Translation Basic (v2). Enable the API in your Google Cloud project. Usage beyond your free allowance may be billed.' : modelProvider ? `Uses a separate ${TRANSLATION_PROVIDER_NAMES[provider]} translation key and model. Enter a text model available to your account. Provider charges and limits apply.` : 'Uses your selected chat provider, saved credentials, and model. Its normal API charges apply.'}</p>
    </div>
    {provider === 'offline' && <OfflineTranslationSetup />}
    {provider !== 'chat' && provider !== 'offline' && <form className="api-form translation-form" aria-busy={busy} onSubmit={event => void save(event)}>
      <label htmlFor="translation-api-key">{TRANSLATION_PROVIDER_NAMES[provider]} API key</label>
      <div className="key-input"><KeyRound size={16} /><input id="translation-api-key" type={show ? 'text' : 'password'} value={key} maxLength={1000} onChange={event => { setKey(event.target.value); edit() }} disabled={busy} autoComplete="off" spellCheck={false} placeholder={settings[provider].configured ? 'Saved key in use; enter a key to replace it' : 'Paste your translation API key'} /><button type="button" disabled={busy} aria-label={show ? 'Hide translation API key' : 'Show translation API key'} aria-pressed={show} onClick={() => setShow(!show)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
      {provider === 'azure' && <div className="connection-field"><label htmlFor="translation-region">Azure resource region</label><input id="translation-region" value={region} maxLength={50} disabled={busy} onChange={event => { setRegion(event.target.value); edit() }} placeholder="e.g. eastus" autoComplete="off" spellCheck={false} /><p>Copy the region identifier from Azure’s Keys and Endpoint page. Leave blank only for a global Translator resource that does not require a region.</p></div>}
      {modelProvider && <div className="connection-field"><label htmlFor="translation-model">Translation model</label><input id="translation-model" value={model} maxLength={120} disabled={busy} onChange={event => { setModel(event.target.value); edit() }} autoComplete="off" spellCheck={false} /><p>Used only for caption translation. Your Q&amp;A chat model stays unchanged.</p></div>}
      <p>{settings[provider].persistence === 'memory' ? 'This key is held in memory until the app exits because encrypted storage is unavailable.' : 'Saved keys use operating-system encryption when available; otherwise they remain in memory until exit. Saved keys are never displayed again.'}</p>
      <div className="connection-action-area">
        <ConnectionFeedback status={status} hint={dirty ? 'Unsaved changes. Save & test will save these settings and verify the connection.' : configured ? 'Settings saved. Test the connection to verify access.' : 'Enter your API key, then choose Save & test connection.'} />
        <div className="settings-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void test()}>{action === 'test' && <LoaderCircle size={14} className="connection-spinner" />}{action === 'test' ? 'Testing…' : dirty ? 'Save & test connection' : 'Test connection'}</button><button type="submit" className="secondary-button" disabled={busy || !dirty}>{action === 'save' ? 'Saving…' : 'Save translation settings'}</button>{settings[provider].configured && <button type="button" className="danger-text" disabled={busy} onClick={event => void save(event, true)}>{action === 'remove' ? 'Removing…' : 'Remove key'}</button>}</div>
      </div>
      <p>Testing sends a short sample. New keys and edits are saved first. Live caption text is sent only when Translate is enabled.</p>
    </form>}
    {provider === 'chat' && status && <ConnectionFeedback status={status} hint="" />}
  </section>
}
