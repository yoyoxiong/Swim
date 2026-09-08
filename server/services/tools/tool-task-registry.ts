interface ActiveToolTask {
  userId: string
  controller: AbortController
}

const globalForToolTasks = globalThis as typeof globalThis & {
  __skyChatActiveToolTasks?: Map<string, ActiveToolTask>
}

const activeToolTasks =
  globalForToolTasks.__skyChatActiveToolTasks ??
  new Map<string, ActiveToolTask>()

globalForToolTasks.__skyChatActiveToolTasks = activeToolTasks

export function registerToolTask(
  toolCallId: string,
  userId: string,
  controller: AbortController
): void {
  activeToolTasks.set(toolCallId, {
    userId,
    controller,
  })
}

export function unregisterToolTask(
  toolCallId: string,
  controller: AbortController
): void {
  const current = activeToolTasks.get(toolCallId)

  // 防止旧任务清理掉同 ID 的新任务
  if (current?.controller === controller) {
    activeToolTasks.delete(toolCallId)
  }
}

export function cancelToolTask(toolCallId: string, userId: string): boolean {
  const task = activeToolTasks.get(toolCallId)

  // 不存在或者不属于当前用户，都不允许取消
  if (!task || task.userId !== userId) {
    return false
  }

  task.controller.abort()
  return true
}
