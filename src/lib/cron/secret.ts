// The shared secret of the cron endpoints (`x-cron-secret`):
// AUTOMATION_CRON_SECRET, or the file AUTOMATION_CRON_SECRET_FILE names
// (docker-compose.yml generates one into a volume when the operator set
// none; scripts/wacrm.mjs hands it over as the variable). Empty when
// neither is set — the endpoints then answer 503.

import fs from 'node:fs'

export function cronSecret(): string {
  const inline = process.env.AUTOMATION_CRON_SECRET?.trim()
  if (inline) return inline
  const file = process.env.AUTOMATION_CRON_SECRET_FILE?.trim()
  if (!file) return ''
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}
