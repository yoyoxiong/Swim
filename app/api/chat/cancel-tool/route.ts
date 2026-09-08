import { getCurrentUserId } from '@/server/auth/utils'
import { cancelToolTask } from '@/server/services/tools/tool-task-registry'

export async function POST(req: Request) {
  let userId: string

  try {
    userId = await getCurrentUserId()
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown

  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const toolCallId =
    typeof body === 'object' &&
    body !== null &&
    'toolCallId' in body &&
    typeof body.toolCallId === 'string'
      ? body.toolCallId
      : null

  if (!toolCallId) {
    return Response.json({ error: 'toolCallId is required' }, { status: 400 })
  }

  const cancelled = cancelToolTask(toolCallId, userId)

  if (!cancelled) {
    return Response.json({ error: 'Running tool not found' }, { status: 404 })
  }

  return Response.json({
    success: true,
    toolCallId,
  })
}
