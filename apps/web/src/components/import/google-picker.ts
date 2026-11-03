// The Google Picker, loaded only when the user asks for it (the Drive button). The browser key and the project number
// come from googleImportConfigFn, and the access token from drivePickerTokenFn. Resolves with the picked file id, or
// null when the user cancels. Only the Picker's own script is loaded, from apis.google.com.

const API_SRC = 'https://apis.google.com/js/api.js'
const PRESENTATION_MIME = 'application/vnd.google-apps.presentation'

interface PickerDoc {
  id: string
  name?: string
  mimeType?: string
}
interface PickerResponse {
  action: string
  docs?: PickerDoc[]
}
interface PickerBuilderLike {
  setAppId(id: string): PickerBuilderLike
  setDeveloperKey(key: string): PickerBuilderLike
  setOAuthToken(token: string): PickerBuilderLike
  setTitle(title: string): PickerBuilderLike
  addView(view: unknown): PickerBuilderLike
  setCallback(callback: (response: PickerResponse) => void): PickerBuilderLike
  build(): { setVisible(visible: boolean): void }
}
interface GooglePickerNamespace {
  PickerBuilder: new () => PickerBuilderLike
  DocsView: new (viewId: unknown) => { setMimeTypes(mimes: string): unknown }
  ViewId: { PRESENTATIONS: unknown }
  Action: { PICKED: string; CANCEL: string }
}
interface GoogleGlobal {
  load(name: string, callback: () => void): void
  picker?: GooglePickerNamespace
}

declare global {
  interface Window {
    gapi?: GoogleGlobal
  }
}

function loadApiScript(): Promise<GoogleGlobal> {
  return new Promise((resolve, reject) => {
    if (window.gapi) return resolve(window.gapi)
    const script = document.createElement('script')
    script.src = API_SRC
    script.async = true
    script.onload = () => (window.gapi ? resolve(window.gapi) : reject(new Error('Google did not load its Picker script.')))
    script.onerror = () => reject(new Error('The Google Picker script could not be loaded. Check your connection, or an ad blocker.'))
    document.head.appendChild(script)
  })
}

function loadPickerModule(api: GoogleGlobal): Promise<GooglePickerNamespace> {
  return new Promise((resolve, reject) => {
    if (api.picker) return resolve(api.picker)
    api.load('picker', () => (api.picker ? resolve(api.picker) : reject(new Error('The Google Picker did not start.'))))
  })
}

export interface DrivePickerOptions {
  apiKey: string
  projectNumber: string
  accessToken: string
}

/** Opens the Picker on presentations and resolves with the chosen Drive file id, or null when cancelled. */
export async function pickPresentationFromDrive(options: DrivePickerOptions): Promise<string | null> {
  const api = await loadApiScript()
  const picker = await loadPickerModule(api)
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.PRESENTATIONS)
    view.setMimeTypes(PRESENTATION_MIME)
    const built = new picker.PickerBuilder()
      .setAppId(options.projectNumber)
      .setDeveloperKey(options.apiKey)
      .setOAuthToken(options.accessToken)
      .setTitle('Choose a presentation')
      .addView(view)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) resolve(response.docs?.[0]?.id ?? null)
        else if (response.action === picker.Action.CANCEL) resolve(null)
      })
      .build()
    built.setVisible(true)
  })
}
