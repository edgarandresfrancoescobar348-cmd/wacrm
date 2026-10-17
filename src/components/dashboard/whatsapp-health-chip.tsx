'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'

import type { PhoneHealth } from '@/lib/whatsapp/phone-health'
import { formatPhoneDisplay } from '@/lib/whatsapp/phone-display'
import { cn } from '@/lib/utils'

const DOT_CLASS = {
  GREEN: 'bg-status-good',
  YELLOW: 'bg-status-warning',
  RED: 'bg-status-critical',
  UNKNOWN: 'bg-hover-surface-foreground/60',
} as const

export function WhatsAppHealthChip() {
  const t = useTranslations('Dashboard.overview.health')
  const format = useFormatter()
  const [health, setHealth] = useState<PhoneHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/whatsapp/health')
      .then((res) => (res.ok ? (res.json() as Promise<PhoneHealth>) : null))
      .then((body) => {
        if (!cancelled && body) setHealth(body)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!health) return null

  const limit =
    health.limit?.kind === 'unlimited'
      ? t('unlimited')
      : health.limit
        ? t('perDay', { count: format.number(health.limit.perDay, { notation: 'compact' }) })
        : null

  const label =
    health.state === 'disconnected'
      ? t('disconnected')
      : health.state === 'unavailable'
        ? t('unavailable')
        : health.state === 'qr_connected'
          ? [t('qrConnected'), health.displayPhoneNumber ? formatPhoneDisplay(health.displayPhoneNumber) : null]
              .filter(Boolean)
              .join(' · ')
          : health.state === 'no_business'
            ? t('noBusiness')
            : [health.displayPhoneNumber, t(`quality.${health.quality}`), limit].filter(Boolean).join(' · ')

  const dot =
    health.state === 'connected'
      ? DOT_CLASS[health.quality]
      : health.state === 'qr_connected'
        ? DOT_CLASS.GREEN
        : health.state === 'no_business'
          ? DOT_CLASS.YELLOW
          : health.state === 'disconnected'
            ? DOT_CLASS.RED
            : DOT_CLASS.UNKNOWN

  return (
    <Link
      href="/settings?tab=whatsapp"
      title={t('title')}
      className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg bg-surface px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  )
}
