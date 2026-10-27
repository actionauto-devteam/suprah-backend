export function extensionMessagingServerEnabled(raw = process.env.CRM_EXTENSION_MESSAGING_ENABLED) {
  return String(raw || '').trim().toLowerCase() === 'true';
}
