// Duplicated from areyougo.ing/src/pages/api/ingest.ts — must stay in sync
export function createEmailHash(subject: string, sender: string, recipient: string, dateSeconds: number): string {
  const content = `${subject}|${sender}|${recipient}|${dateSeconds}`
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return `em_${Math.abs(hash).toString(36)}`
}
