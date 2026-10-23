/** Desktop copying must also work when the assistant does not take focus. */
export async function copyResponseText(text: string): Promise<void> {
  if (window.studio?.copyText) await window.studio.copyText(text)
  else await navigator.clipboard.writeText(text)
}
