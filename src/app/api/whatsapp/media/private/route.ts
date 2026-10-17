// GET /api/whatsapp/media/private?path=connection-<id>/… — a personal
// number's media (phase 6).
//
// The file sits in the PRIVATE bucket chat-media-private and is
// downloaded with the caller's own session: storage RLS (migration 086)
// lets only the number's owner read it — no service role, no public URL.
// The bytes are whatever a WhatsApp sender sent, so only inert types
// render inline (untrustedMediaHeaders).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { untrustedMediaHeaders } from '@/lib/media/safe-inline'
import { PRIVATE_MEDIA_BUCKET } from '@/lib/whatsapp/private-media'

const PATH = /^connection-[0-9a-f-]{36}\/[\w./ -]{1,300}$/i

export async function GET(request: Request) {
  try {
    const { supabase } = await requireRole('viewer')
    const path = new URL(request.url).searchParams.get('path') ?? ''
    if (!PATH.test(path) || path.includes('..')) {
      return NextResponse.json({ error: 'Invalid media reference' }, { status: 400 })
    }
    const { data, error } = await supabase.storage.from(PRIVATE_MEDIA_BUCKET).download(path)
    // Not found and not yours look the same.
    if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new Response(new Uint8Array(await data.arrayBuffer()), {
      status: 200,
      headers: {
        ...untrustedMediaHeaders(data.type || null, path.split('/').pop() ?? 'whatsapp-media'),
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
